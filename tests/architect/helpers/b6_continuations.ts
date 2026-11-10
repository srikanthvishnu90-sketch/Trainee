// Instinct's B.6 continuations 1-5 (docs/architect/specs/APP-LAYER-15-FIXES.md B.6): the person's turns and Trainee's
// target replies, kept exactly as the spec gives them (proposed replies, not executed ones). `carry` is what RESPONSE-RULES R3
// asks of every later reply: the role, place, recipient or subject the person gave stays in force until they change it, and
// a value they ruled out (`never`) does not come back.
export interface B6Turn { say: string; target: string; decision?: boolean }
// At turn `from` the reply names `value` (unless named is false); from then on no reply names `never`.
export interface B6Carry { from: number; kind: "role" | "place" | "recipient" | "subject"; value: RegExp; never?: RegExp; named?: boolean }
export interface B6Continuation { id: string; title: string; resume: boolean; turns: B6Turn[]; carry: B6Carry[] }

export const B6: B6Continuation[] = [
  {
    id: "C1", title: "the resume remains the same task", resume: true,
    turns: [
      { say: "Make it more like a data analyst resume. Keep it one page.", target: "I will put the Python screening project and analysis skills first, keep the page to one sheet, and leave the experience itself unchanged. The source is your saved intake, not the original uploaded resume. I still need your correct GPA and contact details before this is ready to send outside this chat." },
      { say: "Leave GPA off. What did you change?", target: "I moved the Python screening work above the finance-oriented material, shortened repeated wording and made the bullets easier to scan. I did not add a new job, tool, result or credential. GPA stays off. Contact details are still placeholders." },
      { say: "Can you make the first bullet less wordy?", target: "Proposed replacement: Built a Python screening workflow that combined company, revenue and contact data in one sheet across 100+ targets. This keeps the scale already supplied in the intake. If 100+ is not accurate, tell me the supported count before we use it." },
      { say: "That is fine, give me the PDF.", target: "Here is the revised one-page PDF. GPA is omitted, the first bullet is shorter, and the contact placeholders still need filling. This is a review draft, not ready for an employer." },
      { say: "Why does it still say contact details to fill in?", target: "The source I used did not establish the exact contact details for this resume. I left the missing information visible instead of choosing an address or number. Send the contact line you want printed and I can replace the placeholders." },
      { say: "Now apply with it.", decision: true, target: "Which role should this go to? Before sending, I will show you the target, the final resume and the exact application answers. The draft still has contact placeholders, so it is not ready for submission." },
    ],
    // The spec's own turn-1 reply says "analysis skills", not the title, so only the ruled-out target is checked.
    carry: [{ from: 1, kind: "role", value: /\bdata analyst\b|\banaly/i, never: /\bmachine learning\b|\bengineering manager\b/i, named: false }],
  },
  {
    id: "C2", title: "a shortlist that supports an actual decision", resume: true,
    turns: [
      { say: "Find me five data analyst internships in Chicago. Do not apply.", target: "I will look for roles with a live employer page, a student window you could meet and a clear Chicago location. I will return fewer than five if I cannot verify five." },
      { say: "Which is best for me?", target: "Lakefront first, if you can work onsite on Tuesdays and Thursdays. It has the clearest connection to your Python and SQL work. Prairie is second because it is remote, but I cannot call it eligible until your graduation date is confirmed. Northline is a reasonable backup if the Evanston commute works." },
      { say: "I need remote only.", target: "That removes Lakefront and Northline from this shortlist. Prairie is the only remote example remaining; graduation eligibility is still unresolved. I would keep searching for remote-US analytics roles rather than fill the list with onsite jobs." },
      { say: "Try business analyst too.", target: "I will widen the role title to business analyst and analytics intern, keep remote-US as a hard requirement and leave applications off." },
      { say: "Why not that Stripe one?", target: "The Data Analyst Intern page inspected for this study lists New York, Seattle and South San Francisco HQ, not Chicago or remote-US. It also asks for graduation in December 2027 or spring/summer 2028. I have not established that your graduation date meets that window." },
    ],
    carry: [
      { from: 1, kind: "role", value: /\b(?:data|business) analyst|\banalytics\b/i },
      // After "I need remote only" (turn 3) the search is remote; a Chicago-only widening no longer fits what they asked.
      { from: 3, kind: "place", value: /\bremote\b/i, never: /\binclude the Chicago area\b|\bthe Chicago area \(the suburbs too\)/i },
    ],
  },
  {
    id: "C3", title: "application review is a visible artifact", resume: true,
    turns: [
      { say: "Apply to the top three.", decision: true, target: "I can prepare the three packets. Before any submission, I will show you the role, the resume and the exact answers for that employer. The draft still needs your graduation date, work-authorization answer and contact details." },
      { say: "Start with the first one.", target: "For the fictional Lakefront role, the packet below has the proposed why-this-role answer and resume filename. Graduation date, onsite availability and work authorization are blank. Nothing is submitted." },
      { say: "Make the answer less formal.", target: "Proposed replacement: I like work where data helps someone make a concrete decision. In my Python screening project, I pulled company, revenue and contact data into one sheet across 100+ targets. I would like to build on that experience with a team that uses SQL and analysis to improve day-to-day operations." },
      { say: "Use that.", target: "I will use that version in the draft. The required graduation, availability and work-authorization fields remain unanswered. Please give your truthful answers before we reach submission." },
      { say: "Can you just pick the best answers?", target: "I can improve wording, but I cannot choose your legal work status or graduation date. Those need to be your answers. I can keep the rest of the draft ready while you check." },
      { say: "Never mind, just send me the packet.", target: "Here is the review packet. It is marked not submitted, the missing answers are still blank and the latest why-this-role text is included." },
    ],
    carry: [],
  },
  {
    id: "C4", title: "ambiguity handled without losing momentum", resume: true,
    turns: [
      { say: "Send this one.", decision: true, target: "The revised resume PDF, or the application packet? And do you want it here or sent to someone?" },
      { say: "The PDF to me.", target: "Here is the revised PDF." },
      { say: "Now send it to Maya.", decision: true, target: "Which Maya, and where should I send it?" },
      { say: "Maya at the company.", decision: true, target: "I still need the exact recipient or the conversation you mean. I can draft a short note while you find it." },
      { say: "What would you say?", target: "Draft: Hi Maya, attaching my revised resume for the data analyst internship. Thanks for taking a look. [Your name]" },
      { say: "Make it warmer.", target: "Draft: Hi Maya, I am attaching my revised resume for the data analyst internship. I would really appreciate any feedback when you have a chance. Thanks for your time, [Your name]." },
      { say: "A little less formal.", target: "Draft: Hi Maya, here is my revised resume for the data analyst internship. I would love your feedback if you have a chance. Thanks, [Your name]." },
    ],
    // "Maya at the company" names no address: none may be guessed (E.4 41), and Maya stays the recipient of the drafts.
    carry: [{ from: 5, kind: "recipient", value: /\bMaya\b/, never: /\bmaya[._]?[a-z]*@[a-z0-9.-]+\.[a-z]{2,}\b/i }],
  },
  {
    id: "C5", title: "research produces an opinion the user can inspect", resume: false,
    turns: [
      { say: "I have a Stripe analyst interview. Tell me what I should know, not a generic company overview.", target: "Which team or role is it for? I can start with the business model and the analyst-relevant product questions, then tailor the brief when you have the role." },
      { say: "Data analyst internship.", target: "The role page emphasizes metrics, dashboards, data assets, experiments and business recommendations. I would prepare one example of turning messy data into a decision, plus one example of checking whether a metric is misleading. I have put the source-backed company and product notes below." },
      { say: "What is the most interesting thing about the business?", target: "My interpretation: the company is easier to understand as payments plus software for the revenue lifecycle than as card processing alone. Billing handles subscriptions and invoicing; Radar manages fraud risk. That means an analyst may need to explain tradeoffs between revenue, payment success and risk, not maximize a single conversion number." },
      { say: "Give me one question that will not sound copied.", target: "When you evaluate a change that improves payment success, how do you check that it has not simply moved more loss or manual work downstream? I would ask it because Radar and payments create a real measurement tradeoff, not because a source says your specific team owns it." },
      { say: "What numbers should I remember?", target: "Stripe reported $1.9 trillion of total volume for businesses on Stripe in 2025, up 34% from 2024. That is volume, not Stripe revenue. In February 2026 it said the Revenue suite was on track for a $1 billion annual run rate that year; that was a forecast at the time, not proof it reached it." },
      { say: "Does this mean I qualify for the internship?", target: "No. The inspected role page has a specific graduation window and office locations. I have not confirmed your graduation date, relocation willingness or the rest of the application requirements. The brief prepares an interview; it does not establish eligibility or guarantee a job is still accepting applications." },
    ],
    // From turn 2 the subject is the Stripe data analyst internship: a later reply that names a company names Stripe.
    carry: [{ from: 2, kind: "subject", value: /\bStripe\b/, never: /\bLakefront\b|\bNorthline\b|\bPrairie\b/, named: false }],
  },
];
