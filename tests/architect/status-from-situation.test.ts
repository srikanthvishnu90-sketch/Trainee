// STATUS FROM THE SITUATION (2026-11-01): a status ask is answered from every task in flight (the apply queue, prepared
// applications, open questions, outreach drafts, the tracker), as the handler reads them each turn (career_situation.ts
// readSituation) and puts them on ctx.situation. The architect's status rule: Trainee's own records say "sent" only from a
// send record; the person's tracker is always "from what you told me", never merged with or overruled by Trainee's records;
// every count of sends and every "not sent" is scoped to the two weeks the situation reads (D-007); no negative is said
// from a source that could not be read. The in-flight world (evals/career/worlds/in-flight.json, SYNTHETIC): Notion
// confirmed (NOT-55812); Plaid stopped on an emailed code; Ramp failed (phone number required); Brex queued; Figma prepared
// with 2 open questions; Airtable asked for, not taken; a draft to Jordan Lee waiting, Gmail not connected; Plaid on the
// tracker as Submitted (the person's own report).
import assertNode from "node:assert/strict";
import { openWorld, USER } from "../../evals/career/world.ts";
import { readSituation } from "../../supabase/functions/_shared/career_situation.ts";

const W = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
const SENT_CLAIM = /\b(?:i (?:have |just )?(?:applied|submitted)|applied for you|was submitted|has been submitted|application (?:was |is )?sent)\b/i;
const UNSCOPED_NEGATIVE = /nothing (?:has )?(?:gone|was sent)|no applications? (?:sent|on file)|haven't sent (?:anything|an application)(?! (?:to [A-Z][a-z]+ )?in the last two weeks)/i;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const DAY = 86400000;

async function ask(message: string, o: { file?: any; situation?: boolean; fail?: Set<string> } = {}) {
  const w = await openWorld(o.file ?? W, { fail: o.fail });
  const ctx: any = w.H.createTurnCtx({ userId: USER, threadId: "A", now: w.now, accountPersistence: true, snapshot: w.th("A").snapshot, account: w.account, postings: w.kb });
  if (o.situation !== false) ctx.situation = await readSituation(w.admin, USER, w.now);
  const r: any = w.H.runTurn(message, ctx);
  return { intent: r.intent, reply: String(r.reply), snapshot: JSON.stringify(w.H.extractSnapshot(ctx)) };
}

Deno.test("a whole-pipeline status ask: Trainee's records and the tracker, each in its own words", async () => {
  for (const m of ["whats happening with my applications", "how many did you apply to"]) {
    const r = await ask(m);
    assertNode.equal(r.intent, "tracking_status", m);
    assertNode.match(r.reply, /^I sent 1 application in the last two weeks; 5 more are not sent yet\./, r.reply);
    assertNode.match(r.reply, /\nNotion: sent, and Notion confirmed it \(NOT-55812\)\./);
    assertNode.match(r.reply, /\nBrex: queued, not sent yet\./);
    assertNode.match(r.reply, /\nFigma: prepared, not sent; waiting on your yes and 2 answers\./);
    assertNode.match(r.reply, /\nRamp: not sent \(phone number is required\)\./);
    assertNode.match(r.reply, /\nAirtable: asked for, not prepared yet/);
    assertNode.match(r.reply, /\nEmail to Jordan Lee[^\n]*: drafted, not sent; Gmail isn't connected\./);
    // The queue's Plaid (stopped on a code) and the tracker's Plaid (Submitted, their report) are both said, each as what it is.
    assertNode.match(r.reply, /\nPlaid: not sent yet; the employer emailed a code\./);
    assertNode.match(r.reply, /\nFrom what you told me: Plaid \(Business Analyst\), Submitted\./);
    assertNode.doesNotMatch(r.reply, /Plaid: sent/);
    assertNode.doesNotMatch(r.reply, SENT_CLAIM);
    assertNode.doesNotMatch(r.reply, UNSCOPED_NEGATIVE);
    // Read only: the turn's situation is never written into the thread's snapshot.
    assertNode.doesNotMatch(r.snapshot, /NOT-55812/);
  }
});

Deno.test("a named employer gets its own lines; one with nothing from Trainee is scoped, never 'nothing was sent'", async () => {
  const plaid = await ask("did my plaid application go through");
  assertNode.match(plaid.reply, /^Plaid: not sent yet; the employer emailed a code\./, plaid.reply);
  assertNode.match(plaid.reply, /From what you told me: Plaid \(Business Analyst\), Submitted\./);
  assertNode.doesNotMatch(plaid.reply, /Notion|Brex|went through/);
  const fig = await ask("whats the status of my figma application");
  assertNode.match(fig.reply, /^Figma: prepared, not sent; waiting on your yes and 2 answers\.\nWant to answer Figma's questions now\?/);
  const none = await ask("did my plaid application go through", { file: { now: W.now, postings: W.postings } });
  assertNode.match(none.reply, /^I haven't sent an application to Plaid in the last two weeks\.\nIf you applied on your own, tell me the role and I'll track it\./, none.reply);
  assertNode.doesNotMatch(none.reply, SENT_CLAIM);
  assertNode.doesNotMatch(none.reply, UNSCOPED_NEGATIVE);
});

Deno.test("D-007: a confirmed application older than two weeks is never denied, only scoped", async () => {
  // Notion confirmed 30 days ago: the situation (14 days of finished work) does not hold it.
  const file = clone(W);
  const notion = file.apply_jobs.find((j: any) => j.company === "Notion");
  notion.created_at = new Date(Date.parse(W.now) - 30 * DAY).toISOString();
  notion.updated_at = new Date(Date.parse(W.now) - 30 * DAY + 300000).toISOString();
  const named = await ask("did my notion application go through", { file });
  assertNode.match(named.reply, /^I haven't sent an application to Notion in the last two weeks\./, named.reply);
  assertNode.doesNotMatch(named.reply, /nothing was sent to Notion|no Notion application|never/i);
  const all = await ask("whats happening with my applications", { file });
  assertNode.match(all.reply, /^I haven't sent an application in the last two weeks; 5 are not sent yet\./, all.reply);
  assertNode.doesNotMatch(all.reply, /\b0 sent\b|nothing (?:has )?(?:gone|was sent)/i);
});

Deno.test("outreach: approved and sending drafts say so, never 'waiting on your yes'; 'sent' only with a send record", async () => {
  for (const [status, want] of [["approved", /Email to Jordan Lee[^\n]*: approved, not sent yet\./], ["sending", /Email to Jordan Lee[^\n]*: approved, going out now; not sent yet\./]] as const) {
    const file = clone(W);
    Object.assign(file.outreach[0], { status, approved_hash: file.outreach[0].hash, approved_at: "2026-10-20T10:00:00.000Z" });
    const r = await ask("whats happening with my applications", { file });
    assertNode.match(r.reply, want, `${status}\n${r.reply}`);
    assertNode.doesNotMatch(r.reply, /Jordan Lee[^\n]*waiting on your yes/, status);
    assertNode.doesNotMatch(r.reply, /Jordan Lee[^\n]*: sent\./, status);
  }
});

Deno.test("a tracker-only row is the person's report, never printed as sent", async () => {
  const file = { now: W.now, postings: W.postings, facts: W.facts, tracked: [{ company: "Wayne Enterprises", role: "Analyst", stage: "Interview" }] };
  const r = await ask("whats happening with my applications", { file });
  assertNode.match(r.reply, /^I haven't sent an application in the last two weeks\.\nFrom what you told me: Wayne Enterprises \(Analyst\), Interview\./, r.reply);
  assertNode.doesNotMatch(r.reply, /Wayne Enterprises: sent|no interview|nothing (?:has )?gone/i);
});

Deno.test("an unreadable source is named and no negative is said from it", async () => {
  const r = await ask("whats happening with my applications", { fail: new Set(["career_apply_jobs"]) });
  assertNode.match(r.reply, /I couldn't read the apply queue just now, so that is missing here\./, r.reply);
  assertNode.doesNotMatch(r.reply, /haven't sent|\bI sent \d/, r.reply);
  const named = await ask("did my notion application go through", { fail: new Set(["career_apply_jobs"]) });
  assertNode.match(named.reply, /^I couldn't read your applications just now, so I can't say whether I sent anything to Notion\./, named.reply);
});

Deno.test("without a situation the tracker answer stands as before", async () => {
  const r = await ask("whats happening with my applications", { situation: false });
  assertNode.match(r.reply, /^Your tracker holds 1 application\./);
});
