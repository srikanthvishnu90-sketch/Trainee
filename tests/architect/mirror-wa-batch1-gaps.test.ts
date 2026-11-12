// MIRROR WA-1 gaps, the pure parts (2026-11-11): what code reads from the owner's benchmark messages before the brain answers
// (supabase/functions/_shared/agent/turn_notes.ts) and the shortener's new guards (career_brain.ts condensedOk). The handler
// test (mirror-wa-batch1-gaps-handler.test.ts) proves the notes reach the brain.
//   deno test -A --no-check tests/architect/mirror-wa-batch1-gaps.test.ts
import assertNode from "node:assert/strict";
import { hypotheticalOf, postingRefOf, replyKind, replyLength, roastOf } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { condensedOk, condenseLimit, REPLY_TARGET } from "../../supabase/functions/agent-chat/career_brain.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const P: Record<string, string> = Object.fromEntries(read("prompts.jsonl").map((t: any) => [t.id, t.prompt]));
const INSTINCT: Record<string, number> = Object.fromEntries(read("instinct.jsonl").map((t: any) => [t.id, t.messages.filter((m: string) => !/^https?:\/\//.test(m)).join(" ").length]));

Deno.test("WA1-G1 a hypothetical person and a hypothetical situation are told apart from a real ask", () => {
  eq(hypotheticalOf(P.C15), "persona", "C15: say i'm a new grad");
  eq(hypotheticalOf(P.C7), "situation", "C7: hypothetically if i had two offers");
  eq(hypotheticalOf("pretend i'm a career changer from nursing, where would i start"), "persona");
  eq(hypotheticalOf("what if i were a senior engineer, would that change the pay"), "persona");
  for (const id of ["C1", "C4", "C8", "C11", "C12", "C17", "C21f"]) eq(hypotheticalOf(P[id]), null, id);
  eq(hypotheticalOf("i'm a new grad with zero internships, how do i get interviews"), null, "a real statement about themselves");
});

Deno.test("WA1-G2 the answer to a roast ask is found, with the question as it was asked; a new question is not an answer", () => {
  const Q = "Tell me about a time you failed: what were you responsible for, what went wrong, and what did you do afterward?";
  const h = [{ role: "user", content: P.C21 }, { role: "assistant", content: Q }, { role: "user", content: P.C22 }, { role: "assistant", content: "Chicago SWE interns: no verified figure." }];
  eq(roastOf(P.C21f, h), { question: Q }, "C21f, one turn after the ask");
  eq(roastOf(P.C22, h.slice(0, 2)), null, "C22 is a new question");
  eq(roastOf("can you draft a follow-up to the recruiter instead", h), null, "a new ask");
  eq(roastOf(P.C21f, [{ role: "user", content: "ask me a behavioral question" }, { role: "assistant", content: Q }]), null, "no roast was asked");
  const far = [...h, { role: "user", content: P.C13 }, { role: "assistant", content: "draft" }, { role: "user", content: P.C14 }, { role: "assistant", content: "draft" }, { role: "user", content: P.C8 }, { role: "assistant", content: "recall" }];
  eq(roastOf(P.C21f, far), null, "past three of their messages the roast ask is no longer live");
});

Deno.test("WA1-G3 the length of a text follows Instinct's per kind: drafts short, a recall one line, everything long", () => {
  eq(replyKind(P.C2), "draft"); eq(replyKind(P.C13), "draft"); eq(replyKind(P.C14), "draft");
  eq(replyKind(P.C5), "question"); eq(replyKind(P.C21), "question");
  eq(replyKind(P.C23), "recall");
  eq(replyKind(P.C8), "everything"); eq(replyKind(P.C9), "everything");
  for (const id of ["C4", "C7", "C11", "C12", "C15", "C17"]) eq(replyKind(P[id]), "answer", id);
  // Each kind's ceiling sits above Instinct's own reply for that turn and below Trainee's live-4 reply where that one ran long.
  for (const id of ["C2", "C13", "C14", "C5", "C21", "C23", "C4", "C7", "C11", "C12", "C15", "C17", "C8"]) ok(INSTINCT[id] <= replyLength(P[id]).max, `${id}: Instinct ${INSTINCT[id]} within ${replyLength(P[id]).max}`);
  for (const [id, live] of [["C13", 427], ["C14", 593], ["C23", 344], ["C21", 414], ["C17", 1243]] as const) ok(live > replyLength(P[id]).max, `${id}: live-4's ${live} is over ${replyLength(P[id]).max}`);
  ok(replyLength(P.C14).max < replyLength(P.C2).max, "a 'way shorter' draft is shorter than a draft");
  // The shortener uses the same limits; the existing short and long targets are the answer and everything kinds.
  eq(condenseLimit(P.C4), REPLY_TARGET.short); eq(condenseLimit(P.C8), REPLY_TARGET.long);
  eq(condenseLimit(P.C23).max, replyLength(P.C23).max);
});

Deno.test("WA1-G4 the shortener never drops the boundary or a caveat", () => {
  const long = "Here is the plan for PayPal. ".repeat(30) + "I can't verify the posting is still open. Nothing was submitted.";
  ok(condensedOk(long, "Start with PayPal. I can't verify the posting is still open. Nothing was submitted.", REPLY_TARGET.short));
  ok(!condensedOk(long, "Start with PayPal. I can't verify the posting is still open.", REPLY_TARGET.short), "the nothing-submitted boundary was dropped");
  ok(!condensedOk(long, "Start with PayPal. Nothing was submitted.", REPLY_TARGET.short), "the caveat was dropped");
  ok(condensedOk("Here is the plan for PayPal. ".repeat(30), "Start with PayPal.", REPLY_TARGET.short), "nothing to keep, nothing required");
});

Deno.test("WA1-G5 'that paypal internship' is the posting the conversation listed; nothing is matched that was not", () => {
  const listed = [{ id: "greenhouse:paypal:1", company: "PayPal", title: "Software Engineer Intern", location: "Chicago, IL", url: "https://boards.greenhouse.io/paypal/jobs/1" },
    { id: "lever:pinterest:2", company: "Pinterest", title: "Software Engineering Intern", location: "Remote", url: "https://jobs.lever.co/pinterest/2" }];
  for (const id of ["C10", "C11", "C18", "C20"]) eq(postingRefOf(P[id], listed).map((e) => e.id), ["greenhouse:paypal:1"], id);
  eq(postingRefOf("make me a tailored resume for that stripe internship", listed), [], "an employer never listed");
  eq(postingRefOf("what's paypal like to work for", listed), [], "no reference back to a posting");
  // With no list kept, an earlier reply's line naming the employer with its link.
  const h = [{ role: "assistant", content: "Start with these:\n1. PayPal, Software Engineer Intern, Chicago https://boards.greenhouse.io/paypal/jobs/1\n2. Pinterest, Remote https://jobs.lever.co/pinterest/2" }];
  eq(postingRefOf(P.C10, [], h).map((e) => e.url), ["https://boards.greenhouse.io/paypal/jobs/1"]);
});
