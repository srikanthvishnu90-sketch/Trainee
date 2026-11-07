// Reconciliation of the Greptile inventory (6 Nov) against release 8: regressions for the records still open at 72c5a046.
import assertNode from "node:assert/strict";
import { adviceQuestion } from "../../supabase/functions/agent-chat/career_staged.ts";
import { hasDraft, unbackedPromises } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { codeInChat } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";

// Record 4: "show me the draft?" is an instruction for code's draft, not an advice question for the brain.
Deno.test("R8R-4 a show-the-draft ask is never an advice question", () => {
  for (const m of ["don't send it  -  show me the draft?", "can I see the draft?", "show me the email?", "give me the counter draft?", "let me see that draft?"]) {
    for (const intent of ["outreach_clarification", "prep_brief"]) assertNode.equal(adviceQuestion(m, intent, {}), false, `${m} / ${intent}`);
  }
  for (const m of ["should I send a thank-you note?", "what should my follow-up email say?", "how do I ask for a referral?"]) {
    assertNode.equal(adviceQuestion(m, "outreach_clarification", {}), true, m);
  }
});

// Record 15 (residual): a draft that opens with a salutation line is the person's text; its promises are not the agent's.
Deno.test("R8R-15 a salutation line opens a requested draft", () => {
  const draft = "Hi Dana,\nThanks for the chat yesterday. I'll text you the portfolio link tonight.\nBest,\nSam";
  assertNode.equal(hasDraft(draft), true);
  assertNode.deepEqual(unbackedPromises(draft, []), []);
  // An ordinary reply that greets inline is still checked.
  assertNode.equal(hasDraft("Hi Sam, nothing matched today, so I'll text you when a role opens."), false);
  assertNode.ok(unbackedPromises("Hi Sam, nothing matched today, so I'll text you when a role opens.", []).length > 0);
});

// The redactor's own marker ("[security code removed]") is not a code word: the next number stays.
Deno.test("R8R-22 a redaction marker does not make the next number a code", () => {
  const keep = (m: string, kept: string[]) => {
    const once = chatInput(m, [], 10000) as any, after = codeInChat(once.message, []);
    const saved: string = after ? after.userContent : once.userContent;
    for (const k of kept) assertNode.ok(saved.includes(k), `${JSON.stringify(m)} keeps ${k}: ${JSON.stringify(saved)}`);
    assertNode.ok(!/\b123\b/.test(saved), `${JSON.stringify(m)}: CVV removed: ${JSON.stringify(saved)}`);
  };
  keep("CVV: 123 and the zip is 94107", ["94107"]);
  keep("The 3 digits on the back are 123\n2024 was the year I opened the account", ["2024 was the year"]);
  // A real code after a real code word is still removed.
  const s = codeInChat((chatInput("CVV: 123 and the verification code is 739201", [], 10000) as any).message, []);
  assertNode.ok(s && !s.userContent.includes("739201"), JSON.stringify(s));
});

// Records 51 and 53: a real acknowledgement passes, and a distress word that is not the person's own feeling asks for none.
import { missingAck } from "../../supabase/functions/_shared/agent/reply_guards.ts";
Deno.test("R8R-51/53 the acknowledgement check reads real acknowledgements and the person's own feeling", () => {
  const stressed = "I'm so stressed about this job search, where do I start?";
  for (const reply of ["I understand how stressful this feels. Start with one target role.", "That sounds really stressful. Start with one target role.", "Sounds like a lot right now. Start with one target role."]) {
    assertNode.equal(missingAck(stressed, reply), false, reply);
  }
  assertNode.equal(missingAck(stressed, "Start with one target role."), true, "a blunt reply is still flagged");
  for (const msg of ["How should I describe handling stressful situations in a cover letter?", "I'm not stressed, just curious how long this takes", "How do I answer 'how do you handle stress' in an interview?"]) {
    assertNode.equal(missingAck(msg, "Lead with one concrete example."), false, msg);
  }
  for (const msg of ["this job search is overwhelming", "honestly burned out on applications", "Overwhelmed. Where do I start?", "I feel so anxious about the offer"]) {
    assertNode.equal(missingAck(msg, "Lead with one concrete example."), true, msg);
  }
});
