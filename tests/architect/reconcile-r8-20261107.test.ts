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
Deno.test("R8R-15 a salutation line after a lead-in opens a requested draft; a reply that greets the person is still checked", () => {
  const draft = "Here is a note you could send.\n\nHi Dana,\nThanks for the chat yesterday. I'll text you the portfolio link tonight.\nBest,\nSam";
  assertNode.equal(hasDraft(draft), true);
  assertNode.deepEqual(unbackedPromises(draft, []), []);
  // Review of f62e2033: the agent greeting the person on the first line is not a draft; its promises are checked.
  for (const r of ["Hi Sam,\nI'll notify you when new roles appear.", "Hello there,\nI'll notify you when new roles appear.", "Hi Sam, nothing matched today, so I'll text you when a role opens."]) {
    assertNode.equal(hasDraft(r), false, r);
    assertNode.ok(unbackedPromises(r, []).length > 0, r);
  }
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
  for (const msg of ["this job search is overwhelming", "honestly burned out on applications", "Overwhelmed. Where do I start?", "I feel so anxious about the offer", "My stress levels are high"]) {
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
  const seps = [" ", " ", " ", " ", " ", " ", " ", " ", "　", "−", "‐", "‑", "－", "​", ".", " − ", " ‐ "];
  for (const lead of ["Verification code: ", "My code is ", "Workday sent me "]) {
    for (const sep of seps) {
      const m = `${lead}739${sep}201`;
      for (const pending of [false, true]) {
        const { saved } = savedOf(m, pending);
        assertNode.ok(!/739|201/.test(saved), `${JSON.stringify(m)} pending=${pending}: ${JSON.stringify(saved)}`);
      }
    }
  }
  // Review of f609ce7d: after a weak cue, a space or dash split joins only as a 3+3 code (as on trunk); year ranges, 8-digit
  // phones and counts split by a space or dash stay. Across a line break, 6-8 digits join unless both groups are years.
  for (const m of ["Workday sent me 7392\n01", "Workday sent me 1234\n5678", "Workday sent me 739 201", "Workday sent me 739-201"]) {
    assertNode.ok(!/7392|1234|5678|739|201/.test(savedOf(m).saved), `${m}: ${savedOf(m).saved}`);
  }
  for (const m of ["The portal lists my dates as 2018-2022, is that right?", "The recruiter emailed me 2025-2026 benefits info.", "they sent me 2024-25 dates", "the portal shows 2019 - 2023",
    "They emailed me 2024 2025 dates", "the portal shows 2024\n2025", "the recruiter texted me 9123 4567", "the recruiter texted me 1234-5678", "the portal shows 12-3456",
    "the portal shows 1200 1500", "portal ID 4821-9032", "Workday sent me 7392 01",
    // review of 529d1d08: a 3+4 phone and an HHMM pair split by a line break stay
    "Recruiter texted me her number:\n555\n1234", "The recruiter emailed me the interview times:\n1030\n1400", "Acme sent me the offer: $30/hour, start 0800\n1600 shift"]) {
    const r = savedOf(m);
    assertNode.equal(r.saved, m, `${JSON.stringify(m)} kept: ${JSON.stringify(r.saved)}`); assertNode.equal(r.reply, false, m);
  }
  // A strong cue removes a dotted code even near money words; a leading-zero line is not a count.
  assertNode.ok(!/739\.201/.test(savedOf("Code 739.201 was sent with my offer letter").saved));
  assertNode.ok(!/7392|015/.test(savedOf("verification code: 7392\n015 days ago").saved), savedOf("verification code: 7392\n015 days ago").saved);
  assertNode.ok(savedOf("verification code: 7392\n15 days ago").saved.endsWith("\n15 days ago"));
  // Review of f62e2033: a European thousands figure is money, never a dotted code; nor is a named number.
  for (const [m, k] of [["The recruiter sent me an offer of 120.000", "120.000"], ["They emailed me 120.000 EUR base", "120.000"], ["they texted me 120.000 euros", "120.000"],
    ["Workday sent me 100.000 USD", "100.000"], ["Recruiter sent me salary range 90.000 - 110.000", "90.000 - 110.000"], ["She sent me 2 offers\n120.000 and 130.000", "120.000 and 130.000"],
    ["Workday sent me req 739.201", "739.201"], ["GPA 3\u00b785", "3\u00b785"]]) assertNode.ok(savedOf(m).saved.includes(k), `${m} keeps ${k}: ${savedOf(m).saved}`);
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
    "The portal sent a code. It is 739201.", "Recruiter texted me 4821", "Workday sent me 739.201", "Workday sent me 739−201", "Verification code: 739.201", "Workday sent me 739 201",
    // review of f62e2033
    "Workday sent me: 739201", "My verification code arrived this morning: 739201", "Here is the code Workday sent: 739201", "Code -> 739201", "Workday sent me:\n739\n201", "The code it sent: 7392\u201101",
    "the code was emailed: 739201", "Code is: 482913", "my verification code is 739201", "They texted me: 482913", "Login code \u2192 482913",
    "They gave me 482913 to log in", "Recruiter texted me 4821.", "Recruiter sent me code K7X9P2", "One-time code: AB12CD", "OTP: K7X9P2", "2FA code: AB12CD"]) {
    assertNode.equal(fileSharesCode(`Jordan Lee\nSupport Lead\n- ${line}\n- Led a team of 6`), true, line);
  }
  for (const line of ["customer portal serving 120000 customers", "Vendor portal handled 35000 orders a year", "Verification engineer, Acme, 2018-2022", "Security code audits 2018-2022",
    "Raised code coverage across 9500 tests", "Verification of 4500 invoices monthly", "My manager sent me 2500 tickets to triage", "OTP service handled 100000 requests per day",
    "2FA adoption rose from 2000 to 8000 users", "Customer portal: 1200000 sessions", "12000 employees", "(415) 555-0134", "San Francisco, CA 94107", "GPA 3.85", "since 2019",
    "Employee ID 482913", "2021 – 2024", "Managed 25 employees and 1200 shipments", "Code review: 4500 PRs merged", "Code coverage: 95% across 9500 tests", "Postal code: 94107",
    "Security code audits: 2018-2022", "Code quality: cut 1200 bugs", "Security code audit: 4500 endpoints", "OTP service: 50000 QPS at p99 40ms", "Built OTP service: 50000 rps",
    // review of d9dfa48f: a code word and a verb or a colon in a heading is not a hand-over
    "Code migration was completed: 1200 microservices", "Legacy code was ported: 3500 COBOL programs", "Legacy code is now: 3500 Java classes", "Code refactor was delivered: 2500 classes",
    "Verification code service was: 50000 SMS/day", "Passcode vault was rolled out: 3400 laptops", "OTP system was: 45000 branches", "OTP flow was redesigned: 45000 merchants onboarded",
    "OTP service is live in: 4500 branches", "Security code is open-sourced: 1200 stars", "Code of conduct training was delivered: 2400 associates", "Building code review is: 3200 permits",
    "Code owner is: 1200 packages", "Code sent to QA: 4800 builds", "Code was emailed: 4800 builds", "Code review came: 4500 comments", "Code review sent: 4500 diffs",
    "Code quality score is: 4500 points", "Code was 1200 microservices", "Cost code: 482913",
    // review of 470e25d9: a count after the number, and trunk's named codes, are resume lines
    "Our code is running in 4500 hospitals", "My code was deployed to 1200 clinics", "The code we shipped was used by 120000 drivers", "The code was sent to 4500 testers",
    "Our code was sent to 4500 merchants for review", "Our OTP is sent to 120000 phones daily", "The code I own is in 4500 trucks", "CPT code: 99213", "Billing - CPT code: 99214",
    "ICD code: 4019", "NAICS code: 541511", "SOC code: 151252", "FIPS code: 06075", "Department code: 4521", "Project code: 2231", "Vendor code: 55120", "Morse code: 1200 wpm",
    "CPT code: 99213 and 99214 billing audits", "My director gave me 4500 SKUs to rationalize", "Client sent me 3500 resumes to screen", "Our code reads 4500 sensors",
    // review of 6f6ed8ad: letters-and-digits labels, and a 4-5 digit figure after "gave/sent me" that does not end the phrase
    "Taxonomy code: 207Q00000X", "Denial code: CO197", "Remark code: MA130", "SAP T-code: ME21N", "Transaction code: ME21N", "AFSC code: 1N0X1", "Exam code: AZ104",
    "Qualification code: BSB50420", "Part code: XR500A", "Lot code: AB1234", "Batch code: 23A45B", "The client sent me 1200 for review", "Manager gave me 2500 in budget",
    "VP gave me 4500 and a deadline", "Leadership gave me 50000 to invest in tooling", "The team sent me 1200 to triage",
    // review of ea5790fb: any size of figure after "gave/sent me" that does not end the phrase; labels with "security", "auth",
    // "verification" or "sign-in" in them
    "Leadership gave me 120000 to invest in tooling", "VP gave me 250000 and a team of 6", "NSF gave me 250000 for research", "Leadership gave me 1500000 in budget",
    "Client sent me 120000 for review", "Azure Security Engineer exam code: AZ500", "CompTIA Security+ exam code: SY0701", "Identity and access (sign-in) exam code: SC300",
    "Security clearance code: TS2019", "Prior auth code: PA4521", "Insurance verification code: VB102", "Certificate verification code: 4KX7P2QZ",
    // review of b805bd0a: a topic word earlier on the line is not the code's label
    "Rolled out MFA; change code: CHG0012345", "Led MFA rollout (change code: CHG0012345)", "2FA rollout. Change code: CHG0012345", "Billed MFA work to charge code: CC4821",
    "Delivered 2FA for client (engagement code: ENG4821)", "OTP module, ServiceNow code: SN4821", "Passcode reset SOP (SOP code: SOP12)", "Built OTP service; release code: R2023A",
    "Two-factor rollout; charge code: TF2021", "One-time migration, charge code: MIG2021", "Received one-time award code: AW2023", "Client sent me feedback; exam code: AZ104"]) {
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
Deno.test("R8R-SIGNIN a code shown on a page is caught; only the page's own random tokens, in their exact formats, are masked", () => {
  const H = "0123456789abcdef".repeat(4);
  // Visible codes fail the invariant, including every form the trunk substring check caught (review of f62e2033), and split codes.
  for (const b of ["Your code is 165736.", "<p>Your code165736</p>", "<p>165736is your code</p>", ">165736<", "<p>x165736</p>", "<p>decade165736</p>", "<p>165736deadbeef</p>",
    "<p>Code:cafe165736beef</p>", '<a href="/v/a165736b0c1d">', '<script>{"id":"ab165736cd12"}</script>', "<p>7b0f8f8e-6a43-4a49-9d2c-000165736a01</p>",
    '<input type="hidden" name="t" value="165736">', '<input type="hidden" name="ref" value="165736">', '<input type="hidden" name="set" value="1.165736">', '<input value="165736">',
    '<p title="165736">', "<p>165 736</p>", "code: 165-736", "165\u2013736", "165\u00a0736"]) assertNode.ok(codeShown(b, "165736"), b);
  // The page's own random tokens: fp1./fs1. (64 hex), hidden t/set/tag/ref values in their exact lengths, the Application tag.
  for (const b of [`<input type="hidden" name="t" value="fp1.${H.slice(0, 20)}165736${H.slice(26)}">`, `fs1.${H.slice(0, 30)}165736${H.slice(36)}`,
    '<input type="hidden" name="set" value="b2165736e1aa04f1">', '<input type="hidden" name="tag" value="4165736012345678">', '<input type="hidden" name="ref" value="a16573600c4d">',
    "<dt>Application</dt><dd>a1657360b2c3d4e5</dd>"]) assertNode.ok(!codeShown(b, "165736"), b);
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
  // A two-group value before a count is one code: no part of it stays (review of f62e2033).
  assertNode.ok(!/7392|\b01\b/.test(savedOf("my code is 7392\n01 2 minutes ago").saved), savedOf("my code is 7392\n01 2 minutes ago").saved);
  // Phone groups on separate lines stay a phone; a code split by a line break still goes whole.
  assertNode.ok(savedOf("call me at 415\n555\n1234 the portal").saved.includes("415\n555\n1234"));
  assertNode.ok(!/739|201/.test(savedOf("Verification code: 739\n201").saved));
});

// Review of 470e25d9: chat keeps trunk's named-code list, so a store, cost or building code handed over in chat is removed.
Deno.test("R8R-STORE store, cost and building codes handed over in chat are removed", () => {
  for (const m of ["Kroger store code arrived: 482913", "store code it sent: 482913", "Store code from the text: 482913", "store code -> 482913", "Here is the store code Workday sent: 482913",
    "Here's the store code. It is 482913.", "Building code from Workday: 482913", "Workday cost code 482913 came by text", "cost code? it's 482913", "the store code they texted me is 482913"]) {
    assertNode.ok(!/482913/.test(savedOf(m).saved), `${JSON.stringify(m)}: ${JSON.stringify(savedOf(m).saved)}`);
  }
});

// Review of ea5790fb: a one-time-code word counts only on the code's own line, so a job title above it changes nothing.
Deno.test("R8R-92 a title line above a label never makes it a hand-over", () => {
  for (const t of ["Jordan Lee\nSecurity Engineer\n- Exam code: AZ104", "Jordan Lee\nAuth Platform Lead\nCertifications\nExam code: AZ104", "Jordan Lee\nLogin team\n- SAP T-code: ME21N",
    "Jordan Lee\nSecurity Analyst\nSkills: SAP T-code: ME21N"]) assertNode.equal(fileSharesCode(t), false, t);
  for (const t of ["Jordan Lee\nSecurity Engineer\n- Recruiter sent me code K7X9P2", "Jordan Lee\nSupport Lead\n- One-time code: AB12CD", "Jordan Lee\n- They gave me 482913 to log in"]) {
    assertNode.equal(fileSharesCode(t), true, t);
  }
});
