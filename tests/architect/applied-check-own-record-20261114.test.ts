// S3 eval (after #832): the brain called list_applications (ok) and answered "There are no applications on your account yet",
// and code replaced it with "I haven't checked your application record in this reply", which was false. A successful
// list_applications is a lookup of Trainee's own record (never of their email). Review of #845: it gets the normal claim check
// (the status is code's statement from the list's rows; no sentence about status, mail or Gmail stays), the line that the email
// was not checked is code's and always there, and a read that could not read everything (the situation's read failed) is partial.
//   deno test -A --no-check tests/architect/applied-check-own-record-20261114.test.ts
import assertNode from "node:assert/strict";
import * as B from "../../supabase/functions/agent-chat/career_brain.ts";

const { applicationsEnforced, lookupOf, statusLike } = B;
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const MSG = "what stopped the ones that didn't go through?";
const REPLY = "There are no applications on your account yet, so nothing has failed or been stopped. Nothing is queued, prepared, sent or failed, and nothing has gone out for you.\n\nIf you applied somewhere on your own and it didn't go through, tell me the company and what happened, and I'll record it.\n\nTo start fresh, which role are you after?";
const NOTE = "That is Trainee's own record; your email was not checked for this answer.";
const LIST = [{ name: "list_applications", ok: true }, { name: "get_situation", ok: true }];
const ACME = "Acme (SWE Intern), Submitted, 2026-11-01";

Deno.test("S3 repro: a successful list_applications is a lookup of Trainee's own record, stated by code with its basis", () => {
  ok(statusLike(REPLY));
  const look = lookupOf(LIST, null, { unreadable: [], found: [] });
  ok(look.tried && look.own && look.status === "complete", JSON.stringify(look));
  const out = applicationsEnforced(REPLY, look, { message: MSG, codeRan: false });
  ok(!/haven't checked your application record/.test(out), out);
  ok(out.startsWith(`Trainee's saved record shows no applications of yours. ${NOTE}`), out);
  ok(out.endsWith("To start fresh, which role are you after?"), out);
  ok(!/\bGmail|Checked: Gmail/.test(out), "never said to be a mail check");
});

Deno.test("review of #845 (1): only what the list's rows hold stands; invented outcomes and mail claims go", () => {
  const look = lookupOf(LIST, null, { unreadable: [], found: [ACME] });
  const r = "Google moved you to interviews last week. Your Gmail shows confirmations from Acme and Stripe. Want me to find more roles like these?";
  const out = applicationsEnforced(r, look, { message: "where do my applications stand?" });
  ok(!/Google moved you|Gmail shows|Stripe/.test(out), out);
  ok(out.startsWith(`Trainee's saved record shows 1 application: ${ACME}. ${NOTE}`), out);
});

Deno.test("review of #845 (2): the not-checked line is code's whatever the reply says; a claim that the email was checked goes", () => {
  const look = lookupOf(LIST, null, { unreadable: [], found: [] });
  for (const r of ["I checked your email was checked too, and you have no applications.", "Your email was checked: there are no applications on your account.", `You have no applications in Trainee's record. ${NOTE}`]) {
    const out = applicationsEnforced(r, look, { message: "any apps out?" });
    eq((out.match(/your email was not checked for this answer/g) ?? []).length, 1, out);
    ok(!/email was checked|checked your email/i.test(out.replace(NOTE, "")), out);
  }
});

Deno.test("review of #845 (3): the situation's read failed: the list read is partial and backs no denial", async () => {
  let n = 0;
  const steps = [{ content: [{ type: "tool_use", id: "t1", name: "list_applications", input: {} }], stop_reason: "tool_use" }, ...Array(4).fill({ content: [{ type: "text", text: REPLY }], stop_reason: "end_turn" })];
  const model = async (p: any) => (p.tools?.length ? steps[n++] ?? steps.at(-1) : { content: [{ type: "text", text: "" }], stop_reason: "end_turn" });
  const r: any = await B.agentTurn({ message: MSG, history: [], stores: { profile: { facts: [] } }, userId: "u-own", threadId: "th-own", now: Date.UTC(2026, 10, 14), model } as any);
  ok((r.tool_calls ?? []).some((c: any) => c.name === "list_applications" && c.ok), JSON.stringify(r.tool_calls));
  ok(!/no applications on your account|shows no applications/.test(r.reply), r.reply);
  ok(/couldn't read the apply queue/.test(r.reply) && r.reply.includes(NOTE), r.reply);
});

Deno.test("own record: a failed list_applications, or one that left no record of what it read, backs nothing", () => {
  for (const look of [lookupOf([{ name: "list_applications", ok: false }], null, { unreadable: [], found: [] }), lookupOf(LIST)]) {
    const out = applicationsEnforced(REPLY, look, { message: MSG });
    ok(!/no applications on your account|shows no applications/.test(out) && /couldn't read/.test(out), out);
  }
});

Deno.test("own record: a mail lookup in the same turn decides; list_applications never stands in for it", () => {
  const both = lookupOf([{ name: "list_applications", ok: true }, { name: "read_application_mail", ok: true }],
    { status: "complete", could_not_read: [], read: ["Gmail account a@x.test", "Trainee's saved record"], found: [] }, { unreadable: [], found: [] });
  ok(!both.own && both.status === "complete", JSON.stringify(both));
  const out = applicationsEnforced(REPLY, both, { message: MSG });
  ok(/^I found no applications of yours\. Checked: Gmail account a@x\.test and Trainee's saved record\./.test(out), out);
});

Deno.test("own record: a turn that used the list for something else is untouched", () => {
  const r = "Here are three roles like the last one. Want me to queue any of them?";
  eq(applicationsEnforced(r, lookupOf(LIST, null, { unreadable: [], found: [ACME] }), { message: "find me more like the second one" }), r);
});
