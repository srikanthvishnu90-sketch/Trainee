// S3 eval (after #832): the brain called list_applications (ok) and answered "There are no applications on your account yet",
// and code replaced it with "I haven't checked your application record in this reply", which was false. A successful
// list_applications is a lookup of Trainee's own record (never of their email): the answer stands and says its basis, the
// email was not checked (D-024). A failed or incomplete one backs nothing.
//   deno test -A --no-check tests/architect/applied-check-own-record-20261114.test.ts
import assertNode from "node:assert/strict";
import { applicationsEnforced, lookupOf, statusLike } from "../../supabase/functions/agent-chat/career_brain.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const MSG = "what stopped the ones that didn't go through?";
const REPLY = "There are no applications on your account yet, so nothing has failed or been stopped. Nothing is queued, prepared, sent or failed, and nothing has gone out for you.\n\nIf you applied somewhere on your own and it didn't go through, tell me the company and what happened, and I'll record it.\n\nTo start fresh, which role are you after?";
const NOTE = "That is Trainee's own record; your email was not checked for this answer.";

Deno.test("S3 repro: a successful list_applications is a lookup of Trainee's own record; the answer stands and says the email was not checked", () => {
  ok(statusLike(REPLY));
  const look = lookupOf([{ name: "list_applications", ok: true }, { name: "get_situation", ok: true }]);
  ok(look.tried && look.own, JSON.stringify(look));
  const out = applicationsEnforced(REPLY, look, { message: MSG, codeRan: false });
  ok(!/haven't checked your application record/.test(out), out);
  eq(out, `${REPLY}\n\n${NOTE}`);
  ok(!/\bGmail account|Checked: Gmail/.test(out), "never said to be a mail check");
});

Deno.test("own record: a failed or incomplete list_applications backs no denial", () => {
  const failed = applicationsEnforced(REPLY, lookupOf([{ name: "list_applications", ok: false }]), { message: MSG });
  ok(!/no applications on your account/.test(failed) && /couldn't read/.test(failed), failed);
  const partial = applicationsEnforced(REPLY, lookupOf([{ name: "list_applications", ok: true }], null, { unreadable: ["apply queue"] }), { message: MSG });
  ok(!/no applications on your account/.test(partial) && /couldn't read apply queue/.test(partial), partial);
});

Deno.test("own record: a mail lookup in the same turn decides; list_applications never stands in for it", () => {
  const both = lookupOf([{ name: "list_applications", ok: true }, { name: "read_application_mail", ok: true }],
    { status: "complete", could_not_read: [], read: ["Gmail account a@x.test", "Trainee's saved record"], found: [] });
  ok(!both.own && both.status === "complete", JSON.stringify(both));
  const out = applicationsEnforced(REPLY, both, { message: MSG });
  ok(/^I found no applications of yours\. Checked: Gmail account a@x\.test and Trainee's saved record\./.test(out), out);
});

Deno.test("own record: an answer that already says the email was not checked is not told twice", () => {
  const r = `You have no applications in Trainee's record. ${NOTE}`;
  eq(applicationsEnforced(r, lookupOf([{ name: "list_applications", ok: true }]), { message: "any apps out?" }), r);
});
