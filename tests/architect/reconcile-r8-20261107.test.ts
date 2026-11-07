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

// Separator residuals (inventory header; records 83-88 family): every Unicode space, a minus sign, a period and more dash forms
// between code groups are removed like a plain space or hyphen, typed or pending; harmless numbers stay.
import { normalizeChatText, redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";
const savedOf = (m: string, pending = false) => {
  const once = chatInput(m, [], 10000, { codePending: pending }) as any;
  const after = codeInChat(once.message, { userContent: once.userContent, removed: once.redacted, codePending: pending });
  return { saved: after ? after.userContent as string : once.userContent as string, reply: after?.reply ?? false };
};
Deno.test("R8R-SEP code groups split by any space, dash, minus or period are removed; decimals and phones stay", () => {
  const seps = [" ", " ", " ", " ", " ", " ", " ", " ", "　", "−", "‐", "‑", "－", "·", "​", "."];
  for (const lead of ["Verification code: ", "My code is ", "Workday sent me "]) {
    for (const sep of seps) {
      const m = `${lead}739${sep}201`;
      for (const pending of [false, true]) {
        const { saved } = savedOf(m, pending);
        assertNode.ok(!/739|201/.test(saved), `${JSON.stringify(m)} pending=${pending}: ${JSON.stringify(saved)}`);
      }
    }
  }
  for (const m of ["Workday sent me 7392 01", "Workday sent me 4821 9374", "Workday sent me 1234-5678"]) {
    assertNode.ok(!/7392|4821|1234/.test(savedOf(m).saved), `${m}: ${savedOf(m).saved}`);
  }
  for (const [m, k] of [["my GPA is 3.85", "3.85"], ["the recruiter texted me 555 1234", "555 1234"], ["call me at 415 555 1234", "415 555 1234"], ["pay is $120.500 a year", "120.500"], ["the portal runs version 2.345.678", "2.345.678"], ["I made $28.50 an hour", "28.50"]]) {
    assertNode.ok(savedOf(m).saved.includes(k), `${m} keeps ${k}: ${savedOf(m).saved}`);
  }
  // The normal form is one form: a resume's hash equals the stored text's hash whatever space it used.
  assertNode.equal(normalizeChatText("a b　c​d 2021−2024"), "a b cd 2021-2024");
});

// Record 95: while an employer's code is pending, code-in-chat still removes tokens; only its fixed reply stays off.
Deno.test("R8R-95 code-in-chat removes tokens while a code is pending, without its fixed reply", () => {
  for (const m of ["Workday sent me 4821", "Workday sent me 7392\n01", "Verification code: K7X9P2", "The portal sent a code. It is 4821.", "Workday sent me 739 201", "the portal code is K7X9P2", "Lever texted me 1234\n5678", "the portal sent me 12345\n678"]) {
    const { saved, reply } = savedOf(m, true);
    assertNode.ok(!/4821|7392|K7X9P2|739|1234|12345/.test(saved), `${JSON.stringify(m)}: ${JSON.stringify(saved)}`);
    assertNode.equal(reply, false, m);
  }
});

// Records 92 and 96: a code handed over inside an uploaded resume file is refused at upload; resume numbers stay a resume.
import { fileSharesCode } from "../../supabase/functions/_shared/career_code_in_chat.ts";
Deno.test("R8R-92 a resume file with a handed-over code is refused; harmless resume numbers are not", () => {
  for (const line of ["Workday sent me 739201", "Workday sent me 739 201", "Workday sent me 739\n201", "My one-time passcode arrived: 739201", "Lever texted me 7392\n01",
    "The portal sent a code. It is 739201.", "Recruiter texted me 4821", "Workday sent me 739.201", "Workday sent me 739−201", "Verification code: 739.201", "Workday sent me 739 201"]) {
    assertNode.equal(fileSharesCode(`Jordan Lee\nSupport Lead\n- ${line}\n- Led a team of 6`), true, line);
  }
  for (const line of ["customer portal serving 120000 customers", "Vendor portal handled 35000 orders a year", "Verification engineer, Acme, 2018-2022", "Security code audits 2018-2022",
    "Raised code coverage across 9500 tests", "Verification of 4500 invoices monthly", "My manager sent me 2500 tickets to triage", "OTP service handled 100000 requests per day",
    "2FA adoption rose from 2000 to 8000 users", "Customer portal: 1200000 sessions", "12000 employees", "(415) 555-0134", "San Francisco, CA 94107", "GPA 3.85", "since 2019",
    "Employee ID 482913", "2021 – 2024", "Managed 25 employees and 1200 shipments"]) {
    assertNode.equal(fileSharesCode(`Jordan Lee\nSupport Lead\n- ${line}\n- Led a team of 6`), false, line);
  }
});

// Records 92 and 96 through the real upload path: a DOCX with a handed-over code is refused and nothing is stored; the same
// resume with ordinary numbers is kept, its message carries the numbers word for word.
import { ingestResumeFile } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { DOCX, docxBytes } from "./scenarios/onboarding-r2-generator.ts";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const docxOf = (lines: string[]) => docxBytes(lines.map((t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`).join(""));
const BODY = ["Jordan Lee", "Experience", "Operations Analyst, Acme Corp, 2019 - 2024", "Led weekly reporting across four teams and cut close time by two days.", "Built a customer portal serving 120000 customers.",
  "Managed 25 employees and 1200 shipments a month.", "Verification engineer work, 2018-2022.", "San Francisco, CA 94107 | (415) 555-0134 | GPA 3.85", "Education", "BS Economics, State University, 2019", "Skills", "SQL, Excel, Tableau"];
async function ingest(lines: string[]) {
  const bytes = docxOf(lines), stored: any[] = [];
  const res = await ingestResumeFile({ userId: "TEST-r8r", channel: "telegram", doc: { fileId: "F", uniqueId: crypto.randomUUID(), name: "resume.docx", mime: DOCX, size: bytes.length },
    fetchFile: async () => ({ ok: true, bytes }), record: async (row) => { stored.push(row); return "id"; } });
  return { res, stored };
}
Deno.test("R8R-92 handler path: an uploaded DOCX with a handed-over code is refused, a plain one is kept intact", async () => {
  const plain = await ingest(BODY);
  assertNode.ok(plain.res.ok, JSON.stringify(plain.res));
  for (const k of ["120000 customers", "1200 shipments", "2018-2022", "94107", "(415) 555-0134", "3.85"]) assertNode.ok((plain.res as any).message.includes(k), k);
  for (const line of ["Workday sent me 739201", "Lever texted me 7392", "My one-time passcode arrived: 739 201", "Workday sent me 739.201"]) {
    const bad = await ingest([...BODY.slice(0, 4), line, ...BODY.slice(4)]);
    assertNode.equal(bad.res.ok, false, line); assertNode.equal((bad.res as any).why, "secret", line); assertNode.equal(bad.stored.length, 0, line);
    assertNode.ok(/one-time code/.test((bad.res as any).reply), `${line}: ${(bad.res as any).reply}`);
  }
});

// CI run 42348230248 (shard 6/6): the sign-in battery's "a one-time code on a page" check matched a code's digits inside a
// random hex token. The check reads the code as a reader sees it, whole or split, and never inside a token.
import { codeShown } from "./scenarios-file-signin-r4-battery.ts";
Deno.test("R8R-SIGNIN a code shown on a page is caught whole or split; its digits inside a random token are not the code", () => {
  // Visible codes fail the invariant: whole, glued to words, split in two groups (independent check of 41afa39f).
  for (const b of ["Your code is 165736.", "<p>Your code165736</p>", "<p>165736is your code</p>", ">165736<", "<p>x165736</p>", "<p>165 736</p>", "code: 165-736", "165\u2013736", "165\u00a0736"]) assertNode.ok(codeShown(b, "165736"), b);
  // Only the page's proven random tokens are masked (CI run 42348230248: "165736" inside one).
  for (const b of ['<input type="hidden" name="t" value="fp1.e3a9b1657361c2f04d9a">', "fs1.0a165736ff9c0a165736ff9c", '<input type="hidden" name="set" value="b2165736e1aa04f1">',
    '<input type="hidden" name="tag" value="4165736012345678">', '<input type="hidden" name="ref" value="a16573600c4d">', "<dd>7b0f8f8e-6a43-4a49-9d2c-000165736a01</dd>", "<dd>e16573600c4d9e2f1a</dd>"]) assertNode.ok(!codeShown(b, "165736"), b);
});

// Independent check of 41afa39f: a second code on the next line after a weak cue is removed; a count on the next line after a
// labeled code is kept.
Deno.test("R8R-NEXTLINE a second code on the next line is removed; a count on the next line stays", () => {
  for (const m of ["Workday sent me 739201\n482913", "my code is 739201\n482913", "Lever texted me 482913\r\n739201"]) {
    const { saved } = savedOf(m);
    assertNode.ok(!/739201|482913/.test(saved), `${JSON.stringify(m)}: ${JSON.stringify(saved)}`);
  }
  for (const m of ["my code is 739201\n2 minutes ago", "code 7392\n2 minutes ago", "code 739-201\n2 minutes ago", "verification code 739201 \n2 mins ago", "Workday sent me 739201\n2 minutes ago"]) {
    const kept = m.slice(m.indexOf("\n"));
    const { saved } = savedOf(m);
    assertNode.ok(saved.includes(kept) && !/739201|7392|739-201/.test(saved), `${JSON.stringify(m)}: ${JSON.stringify(saved)}`);
    if (/code/.test(m)) assertNode.ok(redactIdentity(m).text.endsWith(kept), `redactIdentity ${JSON.stringify(m)}: ${JSON.stringify(redactIdentity(m).text)}`);
  }
  // Phone groups on separate lines stay a phone; a code split by a line break still goes whole.
  assertNode.ok(savedOf("call me at 415\n555\n1234 the portal").saved.includes("415\n555\n1234"));
  assertNode.ok(!/739|201/.test(savedOf("Verification code: 739\n201").saved));
});
