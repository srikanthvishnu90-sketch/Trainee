// STATUS FROM THE SITUATION (2026-11-01): a status ask is answered from every task in flight (the apply queue, prepared
// applications, open questions, outreach drafts, the tracker), as the handler reads them each turn (career_situation.ts
// readSituation) and puts them on ctx.situation. What was sent is said only from a record; everything else says it was not
// sent and what it waits on. The in-flight world (evals/career/worlds/in-flight.json, SYNTHETIC): Notion confirmed
// (NOT-55812); Plaid stopped on an emailed code; Ramp failed (phone number required); Brex queued; Figma prepared with 2
// open questions; Airtable asked for, not taken; a draft to Jordan Lee waiting, Gmail not connected; Plaid on the tracker
// as Submitted (the person's own report).
import assertNode from "node:assert/strict";
import { openWorld, USER } from "../../evals/career/world.ts";
import { readSituation } from "../../supabase/functions/_shared/career_situation.ts";

const W = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
const SENT_CLAIM = /\b(?:i (?:have |just )?(?:applied|submitted)|applied for you|was submitted|has been submitted|application (?:was |is )?sent)\b/i;

async function ask(message: string, o: { file?: any; situation?: boolean; edit?: (sit: any) => void } = {}) {
  const w = await openWorld(o.file ?? W);
  const ctx: any = w.H.createTurnCtx({ userId: USER, threadId: "A", now: w.now, accountPersistence: true, snapshot: w.th("A").snapshot, account: w.account, postings: w.kb });
  if (o.situation !== false) ctx.situation = await readSituation(w.admin, USER, w.now);
  if (o.edit) o.edit(ctx.situation);
  const r: any = w.H.runTurn(message, ctx);
  return { intent: r.intent, reply: String(r.reply), snapshot: JSON.stringify(w.H.extractSnapshot(ctx)) };
}

Deno.test("a whole-pipeline status ask names every application in flight, sent and not sent", async () => {
  for (const m of ["whats happening with my applications", "how many did you apply to"]) {
    const r = await ask(m);
    assertNode.equal(r.intent, "tracking_status", m);
    for (const co of ["Notion", "Plaid", "Ramp", "Brex", "Figma", "Airtable"]) assertNode.match(r.reply, new RegExp(co), `${m}: ${co}\n${r.reply}`);
    assertNode.match(r.reply, /Notion: sent, and Notion confirmed it \(NOT-55812\)/);
    assertNode.match(r.reply, /Brex: queued, not sent yet/);
    assertNode.match(r.reply, /Figma: prepared, not sent; waiting on your yes and 2 answers/);
    assertNode.match(r.reply, /Ramp: not sent \(phone number is required\)/);
    assertNode.match(r.reply, /Jordan Lee[^\n]*drafted, not sent; Gmail isn't connected/);
    assertNode.match(r.reply, /^1 sent, 5 not sent yet\./);
    // Plaid's queue record (stopped on a code) outranks the tracker's "Submitted": never called sent.
    assertNode.doesNotMatch(r.reply, /Plaid: sent|Plaid[^\n]*Submitted/);
    assertNode.match(r.reply, /\nPlaid: not sent yet; the employer emailed a code\./);
    assertNode.equal((r.reply.match(/^Plaid:/gm) ?? []).length, 1, r.reply);
    assertNode.doesNotMatch(r.reply, SENT_CLAIM);
    // Read only: the turn's situation is never written into the thread's snapshot.
    assertNode.doesNotMatch(r.snapshot, /NOT-55812/);
  }
});

Deno.test("a named employer gets its own line; one with nothing on file is said so, never called sent", async () => {
  const plaid = await ask("did my plaid application go through");
  assertNode.match(plaid.reply, /^Plaid: not sent yet; the employer emailed a code\./);
  assertNode.doesNotMatch(plaid.reply, /Notion|Brex|went through/);
  const fig = await ask("whats the status of my figma application");
  assertNode.match(fig.reply, /Figma: prepared, not sent; waiting on your yes and 2 answers\.\nWant to answer Figma's questions now\?/);
  // A person with nothing in flight, asking about a posting's employer.
  const none = await ask("did my plaid application go through", { file: { now: W.now, postings: W.postings } });
  assertNode.match(none.reply, /I don't have a Plaid application on file for you, so nothing was sent to Plaid/);
  assertNode.doesNotMatch(none.reply, SENT_CLAIM);
});

Deno.test("without a situation the tracker answer stands as before", async () => {
  const r = await ask("whats happening with my applications", { situation: false });
  assertNode.match(r.reply, /^Your tracker holds 1 application\./);
});

Deno.test("the queue's record outranks a tracker row for the same employer, whichever comes first", async () => {
  const tracked = { id: "trk:plaid", kind: "tracked", company: "Plaid", title: "Business Analyst", state: "tracked", since: null, blocker: null, evidence: { stage: "Submitted" }, source: "agent_flow_state" };
  for (const where of ["first", "last"]) {
    const r = await ask("whats happening with my applications", { edit: (sit) => where === "first" ? sit.tasks.unshift(tracked) : sit.tasks.push(tracked) });
    assertNode.match(r.reply, /\nPlaid: not sent yet; the employer emailed a code\./, where);
    assertNode.doesNotMatch(r.reply, /Plaid: on your tracker/, where);
  }
});
