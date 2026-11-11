# Trainee against Instinct's documented product: items 3 and 7 head to head (2026-11-10)

Source of Instinct's side: `docs/architect/specs/APP-LAYER-15-FIXES.md` on trunk. Section A.2 holds the five audited user
turns and Trainee's old production replies, A.4 the comparator resume render, A.5 the rubric, the failure patterns and the
comparator's real reply, and B.1-B.6 the target replies. Trainee's side is trunk at `2f72517d`, run on 2026-11-10.

## How this was run (read before the numbers)

- **Real handler, real Postgres 16.** Every Trainee reply below came from `handler-career.ts` through
  `tests/architect/helpers/response_world.ts`: every migration, the PostgREST double and the small posting board, with no
  outbound request (0 recorded). The B.6 replay from #672 (`tests/architect/response-b6-replay-20261109.test.ts`) was run
  unchanged first. A scratch driver (not committed) then reused the same world and scripted model to add what that test
  does not cover. That test does not run A.2, and its threads lack Instinct's context.
- **No real Claude call.** This container has no `ANTHROPIC_API_KEY`, so the staged path ran with the **scripted model**: the
  production brain (`CAREER_BRAIN=staged`) with a scripted Anthropic wire that answers each turn with Instinct's own target
  reply. Spend: $0. This measures what the product does around a good model answer. It does not measure what Claude would
  write. 18 of the 30 B.6 turns and all 5 A.2 turns were answered by code-first handlers, which never call the model. For
  those turns the reply is the same with or without a model; the router-only run returns identical text for them.
- **Instinct's context, reproduced.** Instinct ran its turns in a thread that already held a resume intake. Each thread here
  starts in a thread seeded with a confirmed synthetic TEST intake (`Avery Fixture`, fictional), built from A.4's
  generic description. It has education with a test score, an involvement line and **two conflicting GPA values** (3.8, and
  3.6 under a later heading). It has four experience entries with three bullets each (an AI M&A internship, a private-equity
  internship with the Python screening work across 100+ targets, and two founder roles). It also has Python and Excel,
  one certification, interests, a city and neighbourhood, and **no email or phone**. The real intake is private and was not
  used. Continuations that build on earlier work first ran the earlier turns in the same thread, unscored: C1 after A.2
  resume turn 1; C3 after A.2 search turns 1-2 (the shortlist); C4 after A.2 resume turn 1 and search turns 1-2.
- **Two caveats from the test world.** The board's fictional postings cannot be re-checked live ("not re-checked"), and
  `TRAINEE_FILE_BASE_URL` is unset, so no File page link can be made. Both are flagged where they change a reply.
- **Not reproduced: the daily AI-answer limit (A.2 search turn 2).** The per-person cap variables are ignored on trunk
  (`career_spend_cap.ts` `IGNORED_PERSON_CAP_ENV`), so the at-limit fallback was not triggered. Trainee's search turn 2 is
  the normal reply. Instinct's target for that turn is its at-limit reply.
- **Scoring.** `checkReply` (`supabase/functions/_shared/reply_rubric.ts`) runs on every reply in its own column's thread
  history, with the person's zone `America/Chicago`. The old production replies are scored at the audit clock
  (2026-11-08 5:15 pm CST). Without that clock the stale "as of" check does not fire (16 instead of 17). The A.5 rubric
  (Clarity, Brevity, Context, Ownership, Evidence) has no code; the architect scored it by hand, one point per criterion.
  Failed letters are listed (C, B, X = Context, O, E). When the delivered reply is the target text unchanged, it gets the
  target's score.

## Item 7: bot responses

### Totals (35 turns: A.2's 5, then B.6 continuations 1-5, 30)

| Column | checkReply violations | A.5 by hand |
|---|---|---|
| Old production (A.2 only; B.6 was never run in production) | **17** in 5 turns | **6/25** |
| Instinct target (A.5 better responses, comparator reply, B.2 and B.6 targets) | **5** (A.2: 1, B.6: 4) | **172/175** (A.2 23/25, B.6 149/150) |
| Trainee now, staged path, scripted model | **4** (A.2: 1, B.6: 3, 2 of them in Instinct's own text passed through unchanged) | **140/175** (A.2 21/25, B.6 119/150) |
| Trainee now, router only (no model) | **12** (A.2: 1, B.6: 11) | not scored |
| #672 replay as merged (minimal context: one confirmed fact, no prior turns) | staged 0 (2 more in the spec's own C4 t4 text, not counted), router 16, 3 carry failures | not scored |

checkReply now reports **fewer violations for Trainee than for Instinct's target** (4 against 5). The A.5 hand score
disagrees: 140 against 172. The difference is a set of replies the rubric does not catch: a false "no resume has been
tailored in this chat" after two PDFs were sent, a model instruction leaked into a reply, and a count word read as part
of a job title. Each of these scored 0 rubric violations. **checkReply has no rule for a claim that contradicts the
thread's own earlier turns** (rubric gap; see the shortfalls).

### A.2: the five audited turns

Trainee's replies are identical on the router-only path for all five turns. Code-first handlers (`career_resume_task`,
`career_internship_discovery`, `career_discovery`) answer all five, so no model is called.

| Turn | Person | Old production reply (A.2, quoted) | Instinct target (A.5 / B.2) | Trainee now (trunk, staged path) |
|---|---|---|---|---|
| A.2 Resume 1 | "Can you turn the resume I uploaded into a clean one-page PDF for data analyst internships? Keep the facts as written, don't add experience, and send me the actual PDF." | "There is no document file on this conversation yet to send you. / A file exists here only once a resume has been tailored in this chat — tailoring renders the PDF from your confirmed facts, and the file then rides with my reply. Name the role (or paste the posting) and I will tailor your resume and send the PDF here." | "Here is the one-page PDF, ordered toward data analyst internships. It is built from your saved intake notes rather than the original resume file, so I left GPA off because the sources disagree and marked the contact details to fill in. I did not add experience; I reordered and tightened the supplied draft." | "Here is your one-page resume PDF for data analyst internships. / It's a general version, not written for one posting; send me a posting and I'll tailor it to that. / I used your saved resume intake, not the original file, kept every fact as written and added no experience. / Your GPA is left off because your resume shows two values (3.8 and 3.6). Which one is right? / Your name and contact details aren't on file, so the top shows placeholders. What name and email should go at the top of your resume?" [PDF attached, 1 page] |
| | checkReply violations | 2 (answers_first, repeats_ask) | 0 | 0 |
| | A.5 (C B X O E) | 1/5 fails CBXO | 5/5 | 5/5 |
| A.2 Resume 2 | "The role is a data analyst internship, like I said. Please tailor the resume for that and generate the one-page PDF. If a fact needs my confirmation, ask me the specific question rather than adding anything." | "Your resume is tailored for Ads Conversion Modeling, Machine Learning Engineering Manager at reddit. / It leads with your proven skills, and every line traces to a fact already on your profile. Skill gap, named plainly: Machine Learning is required by the posting and not on your profile, so it was not added to the resume. Eligibility verdict: this record meets the posting's hard requirements, but some required skills the posting names are not evidenced in the record — they are named in the gap list that travels with this packet. / Saved as PDF and DOCX files, attached for your review — parse check PASS. Picked first from the 5 roles that fit your profile in the current list — grounded in your profile record and the posting's own text, as of November 2026. There is no name or email at the top of this file: none was typed for it and none was confirmed with your resume, so nothing is printed there. / What name and email should go at the top of your resume? / What changed: Same as your base resume; it already fits this posting." | "I can make the data analyst internship draft from your saved resume notes. Before I finalize it, please confirm the conflicting GPA and the contact details you want included." | "Here is your one-page resume PDF for data analyst internships. / Your GPA is left off because your resume shows two values (3.8 and 3.6). Which one is right? / Your name and contact details aren't on file, so the top shows placeholders. What name and email should go at the top of your resume?" [PDF attached, 1 page] |
| | checkReply violations | 4 (ends_at_decision, boilerplate_tail, internal, internal) | 1 (ends_at_decision) | 0 |
| | A.5 (C B X O E) | 0/5 fails CBXOE | 5/5 | 5/5 |
| A.2 Resume 3 | "That's the wrong role. I asked for a data analyst internship, not a machine learning manager job at Reddit. Please fix the target and send a download link for the PDF too, since the attachment isn't opening here. Don't apply to anything." | "I haven't started that batch: nothing was searched, prepared or sent, because the runner for that kind of ask is not switched on. What does run: say "apply to the top 10 <role> jobs in <city>", or pick from a list I showed ("apply to all of them", "apply to 1 and 3"), and I put those postings on your apply list; each one is prepared, shown to you exactly as it would be sent, and goes to the employer only after your yes to that card." | "I used the wrong role. I will redo the draft for data analyst internships and will not apply anywhere." | "The file I sent is for data analyst internships, not the machine learning manager job at Reddit; here it is again. / I still need your correct GPA and your contact details before this is ready to send outside this chat. / I haven't applied to anything. / There's no link this time: your private File page couldn't be made (file links aren't set up yet, so the person could not open it. Tell them it isn't available yet; do not claim it was made.)." [PDF attached, 1 page] |
| | checkReply violations | 3 (answers_first, blocker_named, internal) | 0 | 0 |
| | A.5 (C B X O E) | 1/5 fails CBXO | 4/5 fails O; no file, no link answer (the spec itself says it "still needs the actual corrected file to pass") | 3/5 fails CB; leaks an instruction meant for the model |
| A.2 Search 1 | "Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. Show the company, role, location, and application link. Don't apply yet." | "Nothing was invented to fill the list. Widen the role or the place and I'll search again." | "I will look for open Chicago data analyst internships and check the actual application pages. I will return up to five verified matches and will not apply." | "From 1 live posting for data analyst in Chicago (internships), first seen in the last 3 days. / I verified 0 open matches, and listed 1 more I could not re-check. I did not find 5 within the scope checked. Nothing was applied for. / Held to what you asked (internships). / Ranked by how well each matches what you've confirmed. / 1. Data Analyst Intern at Lakefront Transit Analytics — Chicago, IL, arrangement not stated (https://boards.greenhouse.io/rw/jobs/lakefront-da). partial match. /    Student window: "Students graduating December 2027 or later". /    Checked: not re-checked, it is not on a public job board I can check." |
| | checkReply violations | 2 (answers_first, blocker_named) | 0 | 0 |
| | A.5 (C B X O E) | 3/5 fails XO; no coverage, no reason | 4/5 fails O; progress only; the result must follow | 4/5 fails B; stock lines ("Held to what you asked") |
| A.2 Search 2 | "Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships. Even 2 or 3 verified open roles is useful. Show the real links and any student or graduation requirements." | "The window, checked against the record. / I cannot answer that from the record: your graduation date is not stated. Eligibility here is a comparison of two stated facts, and one of them is unknown — I will not guess it. Ask the employer for the exact window wording, or check the posting text, and the comparison is mechanical. / Tell me when you're ready to start: get the posting's exact graduation wording and check it against your stated graduation date. Source: graduation date and posting window as supplied in context (one of the two is missing — named in the unknowns), as of 2026-10-13. Get the posting's exact graduation wording and check it against your stated graduation date. /  / Tell me what you'd like to do next. /  / You've reached today's limit on AI-written answers, so this reply comes from Trainee's built-in steps without the AI. The limit resets at midnight UTC." | "I hit the daily AI-answer limit, so I cannot finish this search right now. It resets at 6 pm Chicago time today; I have not applied anywhere." | "From 3 live postings for data analyst, business analyst or analytics in the Chicago area (Chicago and 37 nearby towns) and remote in the US (internships), first seen in the last 3 days. / I verified 0 open matches, and listed 3 more I could not re-check. 2 are in the Chicago area and 1 is remote in the US. I did not find 5 within the scope checked. Nothing was applied for. / Held to what you asked (internships). / Ranked by how well each matches what you've confirmed. / 1. Data Analyst Intern at Lakefront Transit Analytics — Chicago, IL, arrangement not stated (https://boards.greenhouse.io/rw/jobs/lakefront-da). partial match. /    Student window: "Students graduating December 2027 or later". /    Checked: not re-checked, it is not on a public job board I can check. / 2. Data Analyst Intern at Northline Health Data — Evanston, IL, arrangement not stated (https://boards.greenhouse.io/rw/jobs/northline-da). partial match. /    Student window: not stated in the posting. /    Checked: not re-checked, it is not on a public job board I can check. / 3. Business Analyst Intern at Prairie Ledger — Remote, US, remote (https://boards.greenhouse.io/rw/jobs/prairie-ba). partial match. /    Student window: not stated in the posting. /    Checked: not re-checked, it is not on a public job board I can check. / Say "apply to these" to queue the 3 listed, or name one to tailor your resume for." |
| | checkReply violations | 6 (answers_first, boilerplate_tail, boilerplate_tail, internal, time_zone stale "as of", time_zone UTC) | 0 | 1 (blocker_named) |
| | A.5 (C B X O E) | 1/5 fails CBXO | 5/5; at-limit context | 4/5 fails B; long; stock lines |

### B.6: continuations 1-5, turn by turn


**C1** (context first sent in the same thread: A.2 Can you turn the resume I uploaded into ...)

| # | Person | Instinct target (B.6, quoted) | Trainee now (trunk, staged path) | checkReply: target / Trainee staged / Trainee router-only | A.5: target / Trainee |
|---|---|---|---|---|---|
| 1 | "Make it more like a data analyst resume. Keep it one page." | "I will put the Python screening project and analysis skills first, keep the page to one sheet, and leave the experience itself unchanged. The source is your saved intake, not the original uploaded resume. I still need your correct GPA and contact details before this is ready to send outside this chat." | "Here is the one-page PDF for data analyst internships: I put Private Equity Intern above M&A Intern, kept it to one page and left the experience itself unchanged. / I still need your correct GPA and your contact details before this is ready to send outside this chat." [PDF attached] | 0 / 0 / 0 | 5/5 / 5/5; file attached (same bytes as the earlier draft) |
| 2 | "Leave GPA off. What did you change?" | "I moved the Python screening work above the finance-oriented material, shortened repeated wording and made the bullets easier to scan. I did not add a new job, tool, result or credential. GPA stays off. Contact details are still placeholders." | "I moved Private Equity Intern above M&A Intern; and Founder above Founder. I did not add a new job, tool, result or credential. GPA stays off. Contact details are still placeholders." | 0 / 0 / 0 | 5/5 / 4/5 fails C; "Founder above Founder" reads as nonsense |
| 3 | "Can you make the first bullet less wordy?" | "Proposed replacement: Built a Python screening workflow that combined company, revenue and contact data in one sheet across 100+ targets. This keeps the scale already supplied in the intake. If 100+ is not accurate, tell me the supported count before we use it." | "I couldn't shorten it without changing what it says, so it stays as written: "Built a Python screening workflow that combined company, revenue and contact data in one sheet across 100+ targets"." | 0 / 0 / 0 | 5/5 / 4/5 fails O; no shorter bullet; the scripted rewrite was refused by the audit |
| 4 | "That is fine, give me the PDF." | "Here is the revised one-page PDF. GPA is omitted, the first bullet is shorter, and the contact placeholders still need filling. This is a review draft, not ready for an employer." | "I can't send you a file yet because no resume has been tailored in this chat. / Tailoring renders the PDF from your confirmed facts, and the file then comes with my reply. Which role should I tailor it for?" | 0 / 0 / 0 | 5/5 / 2/5 fails XOE; says no resume was tailored; two PDFs were sent in this thread |
| 5 | "Why does it still say contact details to fill in?" | "The source I used did not establish the exact contact details for this resume. I left the missing information visible instead of choosing an address or number. Send the contact line you want printed and I can replace the placeholders." | "The source I used didn't establish the contact details for this resume, so I left the missing information visible instead of choosing an address or number. Send the contact line you want printed and I'll replace the placeholders." | 0 / 0 / 0 | 5/5 / 5/5 |
| 6 | "Now apply with it." | "Which role should this go to? Before sending, I will show you the target, the final resume and the exact application answers. The draft still has contact placeholders, so it is not ready for submission." | "Which role should this go to? Before anything is sent, I'll show you the target, the final resume and the exact application answers. The draft still needs your contact details, so it isn't ready to submit." | 0 / 0 / 0 | 5/5 / 5/5 |

**C2** (fresh thread with the saved intake)

| # | Person | Instinct target (B.6, quoted) | Trainee now (trunk, staged path) | checkReply: target / Trainee staged / Trainee router-only | A.5: target / Trainee |
|---|---|---|---|---|---|
| 1 | "Find me five data analyst internships in Chicago. Do not apply." | "I will look for roles with a live employer page, a student window you could meet and a clear Chicago location. I will return fewer than five if I cannot verify five." | "I checked five data analyst, five data analytics internships in Chicago, on the live board (last refreshed Nov 9, 10:52 PM CST) and the saved snapshot of job boards: none was found (the live board has no match for it, and the saved snapshot has none either). Nothing was invented to fill the list, and nothing was applied for. The most useful widening is the Chicago area (the suburbs too): say "include the Chicago area", and I'll search again." | 1 (blocker_named) / 0 / 0 | 4/5 fails O; progress only / 1/5 fails CXOE; "five" read as part of the title; says none found though the board holds a Chicago data analyst internship |
| 2 | "Which is best for me?" | "Lakefront first, if you can work onsite on Tuesdays and Thursdays. It has the clearest connection to your Python and SQL work. Prairie is second because it is remote, but I cannot call it eligible until your graduation date is confirmed. Northline is a reasonable backup if the Evanston commute works." | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 1 (answers_first) | 5/5 / 5/5; = target; model text; in this thread no list was shown first |
| 3 | "I need remote only." | "That removes Lakefront and Northline from this shortlist. Prairie is the only remote example remaining; graduation eligibility is still unresolved. I would keep searching for remote-US analytics roles rather than fill the list with onsite jobs." | "I checked five data analyst, five data analytics internships in remote, on the live board (last refreshed Nov 9, 10:52 PM CST) and the saved snapshot of job boards: none was found (the live board has no match for it, and the saved snapshot has none either). Nothing was invented to fill the list, and nothing was applied for. The most useful widening is related titles (business analyst, analytics): say "include business analyst and analytics", and I'll search again." | 0 / 0 / 0 | 5/5 / 4/5 fails C; "five data analyst, five data analytics ... in remote" |
| 4 | "Try business analyst too." | "I will widen the role title to business analyst and analytics intern, keep remote-US as a hard requirement and leave applications off." | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 1 (answers_first) | 5/5 / 5/5; = target |
| 5 | "Why not that Stripe one?" | "The Data Analyst Intern page inspected for this study lists New York, Seattle and South San Francisco HQ, not Chicago or remote-US. It also asks for graduation in December 2027 or spring/summer 2028. I have not established that your graduation date meets that window." | "The Stripe file — Software engineering, entry-level: interns and new graduates. / The bar: Stripe publishes its intern bar in the listing itself: strong CS fundamentals through pursuit of a Bachelor's or Master's in computer science, math or a related discipline; programming experience from side projects or classwork; and experience in previous internships or other multi-person projects — including open source — that shows you can take feedback from mentors, peers and stakeholders. Source: Stripe's company file (public sources), as of 2026-10-12. Want the entry routes or the hiring cadence next?" | 0 / 0 / 0 | 5/5 / 2/5 fails BXO; answers a software-engineering bar, not why that role fails remote or the window |

**C3** (context first sent in the same thread: A.2 Let's leave the resume for now. Find me ..., A.2 Okay, include business analyst and analy...)

| # | Person | Instinct target (B.6, quoted) | Trainee now (trunk, staged path) | checkReply: target / Trainee staged / Trainee router-only | A.5: target / Trainee |
|---|---|---|---|---|---|
| 1 | "Apply to the top three." | "I can prepare the three packets. Before any submission, I will show you the role, the resume and the exact answers for that employer. The draft still needs your graduation date, work-authorization answer and contact details." | "0/3 queued. Not queued: Data Analyst Intern at Lakefront Transit Analytics: not a Greenhouse, Lever, Ashby or Workday posting link I can open yet; Data Analyst Intern at Northline Health Data: not a Greenhouse, Lever, Ashby or Workday posting link I can open yet; Business Analyst Intern at Prairie Ledger: not a Greenhouse, Lever, Ashby or Workday posting link I can open yet." | 1 (ends_at_decision) / 1 (ends_at_decision) / 1 (ends_at_decision) | 5/5 / 3/5 fails CB; says the links are not Greenhouse links; they are (test board not resolvable); repeated three times |
| 2 | "Start with the first one." | "For the fictional Lakefront role, the packet below has the proposed why-this-role answer and resume filename. Graduation date, onsite availability and work authorization are blank. Nothing is submitted." | "Data Analyst Intern at Lakefront Transit Analytics (https://boards.greenhouse.io/rw/jobs/lakefront-da) — Chicago, IL Want me to tailor your resume for it?" | 0 / 0 / 0 | 5/5 / 4/5 fails O; no packet; offers to tailor |
| 3 | "Make the answer less formal." | "Proposed replacement: I like work where data helps someone make a concrete decision. In my Python screening project, I pulled company, revenue and contact data into one sheet across 100+ targets. I would like to build on that experience with a team that uses SQL and analysis to improve day-to-day operations." | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 1 (answers_first) | 5/5 / 5/5; = target |
| 4 | "Use that." | "I will use that version in the draft. The required graduation, availability and work-authorization fields remain unanswered. Please give your truthful answers before we reach submission." | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 1 (answers_first) | 5/5 / 5/5; = target |
| 5 | "Can you just pick the best answers?" | "I can improve wording, but I cannot choose your legal work status or graduation date. Those need to be your answers. I can keep the rest of the draft ready while you check." | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 1 (answers_first) | 5/5 / 5/5; = target |
| 6 | "Never mind, just send me the packet." | "Here is the review packet. It is marked not submitted, the missing answers are still blank and the latest why-this-role text is included." | "I can't send you a file yet because no resume has been tailored in this chat. / Tailoring renders the PDF from your confirmed facts, and the file then comes with my reply. Which role should I tailor it for?" | 0 / 0 / 0 | 5/5 / 3/5 fails XO; answers about a resume, not the packet |

**C4** (context first sent in the same thread: A.2 Can you turn the resume I uploaded into ..., A.2 Let's leave the resume for now. Find me ..., A.2 Okay, include business analyst and analy...)

| # | Person | Instinct target (B.6, quoted) | Trainee now (trunk, staged path) | checkReply: target / Trainee staged / Trainee router-only | A.5: target / Trainee |
|---|---|---|---|---|---|
| 1 | "Send this one." | "The revised resume PDF, or the application packet? And do you want it here or sent to someone?" | "Do you mean submit an application for one of the 3 jobs I listed, or send you the resume PDF for data analyst internships? Nothing is sent until you say." | 0 / 0 / 0 | 5/5 / 5/5; two concrete choices, as B.4 asks |
| 2 | "The PDF to me." | "Here is the revised PDF." | "Here is the resume PDF for data analyst internships." [PDF attached] | 0 / 0 / 0 | 5/5 / 5/5; PDF attached |
| 3 | "Now send it to Maya." | "Which Maya, and where should I send it?" | "Which do you mean, and who should it go to? / Nothing was sent: there is no draft or list in this chat yet, so tell me which one you mean and I'll start it." | 0 / 0 / 0 | 5/5 / 3/5 fails XE; "no draft or list in this chat" is false; the PDF and the list are in it |
| 4 | "Maya at the company." | "I still need the exact recipient or the conversation you mean. I can draft a short note while you find it." | (the same text as the target: the model's answer, delivered unchanged) | 2 (answers_first, ends_at_decision) / 2 (answers_first, ends_at_decision) / 1 (answers_first) | 5/5 / 5/5; = target |
| 5 | "What would you say?" | "Draft: Hi Maya, attaching my revised resume for the data analyst internship. Thanks for taking a look. [Your name]" | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 1 (answers_first) | 5/5 / 5/5; = target |
| 6 | "Make it warmer." | "Draft: Hi Maya, I am attaching my revised resume for the data analyst internship. I would really appreciate any feedback when you have a chance. Thanks for your time, [Your name]." | "I can't revise anything yet because there's no draft in this chat. / The cover-letter ask is still waiting on the facts it is written from, and no outreach draft has been drafted from the plan; once one exists, a change like shorter or more casual applies to it and the original is kept. Give me the facts for the letter, or say 'draft the first one' on the plan, and revision has something real to work on." | 0 / 0 / 0 | 5/5 / 0/5 fails CBXOE; says there is no draft; the draft is the previous reply; brings in a cover letter |
| 7 | "A little less formal." | "Draft: Hi Maya, here is my revised resume for the data analyst internship. I would love your feedback if you have a chance. Thanks, [Your name]." | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 1 (answers_first) | 5/5 / 5/5; = target |

**C5** (fresh thread with the saved intake)

| # | Person | Instinct target (B.6, quoted) | Trainee now (trunk, staged path) | checkReply: target / Trainee staged / Trainee router-only | A.5: target / Trainee |
|---|---|---|---|---|---|
| 1 | "I have a Stripe analyst interview. Tell me what I should know, not a generic company overview." | "Which team or role is it for? I can start with the business model and the analyst-relevant product questions, then tailor the brief when you have the role." | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 0 | 5/5 / 5/5; = target |
| 2 | "Data analyst internship." | "The role page emphasizes metrics, dashboards, data assets, experiments and business recommendations. I would prepare one example of turning messy data into a decision, plus one example of checking whether a metric is misleading. I have put the source-backed company and product notes below." | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 0 | 5/5 / 5/5; = target |
| 3 | "What is the most interesting thing about the business?" | "My interpretation: the company is easier to understand as payments plus software for the revenue lifecycle than as card processing alone. Billing handles subscriptions and invoicing; Radar manages fraud risk. That means an analyst may need to explain tradeoffs between revenue, payment success and risk, not maximize a single conversion number." | (the same text as the target: the model's answer, delivered unchanged) | 0 / 0 / 1 (answers_first) | 5/5 / 5/5; = target |
| 4 | "Give me one question that will not sound copied." | "When you evaluate a change that improves payment success, how do you check that it has not simply moved more loss or manual work downstream? I would ask it because Radar and payments create a real measurement tradeoff, not because a source says your specific team owns it." | "Here is your question: Tell me about yourself and why this role. / Answer it the way you would in the room — out loud, structured, numbers before adjectives. I will score the answer against the rubric and drill the weakest part next; that loop is the prep. Give me your answer and I will score it." | 0 / 0 / 0 | 5/5 / 3/5 fails XO; gives a mock-interview question, not a question to ask |
| 5 | "What numbers should I remember?" | "Stripe reported $1.9 trillion of total volume for businesses on Stripe in 2025, up 34% from 2024. That is volume, not Stripe revenue. In February 2026 it said the Revenue suite was on track for a $1 billion annual run rate that year; that was a forecast at the time, not proof it reached it." | "That is volume, not Stripe revenue." | 0 / 0 / 1 (answers_first) | 5/5 / 2/5 fails CXO; the numbers were stripped (no source in the thread); one orphan sentence left |
| 6 | "Does this mean I qualify for the internship?" | "No. The inspected role page has a specific graduation window and office locations. I have not confirmed your graduation date, relocation willingness or the rest of the application requirements. The brief prepares an interview; it does not establish eligibility or guarantee a job is still accepting applications." | "I can't say yet whether you qualify because I haven't read that posting's requirements in this chat. / It turns on the posting's hard requirements, such as a license, a degree, years of experience or work authorization; none is assumed. Send me the posting's link or its text, and I'll check each requirement against what you've confirmed." | 0 / 0 / 0 | 5/5 / 4/5 fails X; honest, but does not name the Stripe role already under discussion |

### Item 7 verdict

- **Beats Instinct's target:** A.2 resume turns 1-2 and C1 turn 1. Trainee delivers a real one-page PDF with the reply,
  names both GPA values and asks which one is right, and asks one contact question. That is A.5's "unconfirmed facts"
  response with the file the target only promised. A.2 resume turn 3 fixes the target, says "I haven't applied to
  anything" and re-sends the file. A.2 search turns 1-2 return numbered cards with company, title, location, link, student
  window and check status, plus a scope line ("I did not find 5 within the scope checked"). That is B.2's structure, where
  the target only acknowledged.
- **Matches it:** C1 turns 5-6, C4 turns 1-2 (the B.4 two-choice question, then "Here is the resume PDF..." with the file
  attached), and every turn the model answered.
- **Falls short:** C1 t4, C2 t1, C2 t5, C3 t1/t6, C4 t3/t6 and C5 t4/t5, for the reasons in the shortfall list. The
  router-only path also still answers 11 B.6 turns with the "I'm not sure which part of your search that's about" or
  "I'm Trainee, a career agent" fallback (`answers_first`).

## Item 3: resumes (B.1, data analyst internship, one page, from the saved intake)

The real resume path for this ask is the chat's resume task (`career_resume_task.ts`, called from `handler-career.ts`
before the planner). The file below is what A.2 resume turn 1 delivered. It was saved from `channel_artifacts` and opened
the way `scripts/resume-loop.ts` opens files: `scripts/resume-loop-extract.py` (poppler and pdfminer), then its
`inventedIn` and `chronological` checks against the confirmed intake. A page render was inspected visually. All ten PDFs
the threads delivered are byte-identical (md5 `9e5742d5…`, 2,831 bytes). The brain's `tailor_resume` tool, which
`resume-loop.ts` drives, was also run on the same profile with a general data analyst internship target. It **refused**:
"not made: your name and email are not on your profile yet, and an employer's system reads them from the top of the
resume. Ask exactly: "What name and email should go at the top of your resume?". Nothing was stored or sent."

| # | Check (A.4 comparator, A.5 comparator reply, B.1) | Comparator (as A.4 / A.5 describe it) | Trainee now | Result |
|---|---|---|---|---|
| 1 | One page, US Letter, nothing clipped | One page, about a quarter empty | 1 page, 612x792 pt (pdfinfo); about a fifth of the page empty; no clipped bullet | pass |
| 2 | A real file accompanies the reply and opens | Real PDF sent with the reply | PDF rides the reply; opens in poppler and pdfminer | pass |
| 3 | Ordered toward the target (analytics work early) | Education first; Experience holds the AI M&A internship, the PE internship with the Python work and two founder roles (A.4 lists them, not their order); the reply says "ordered toward data analyst internships" | Education, then the PE internship with the Python screening bullet first in Experience (what B.6 C1 asks for) | pass |
| 4 | The rest of the order is coherent | Not stated | Founders printed 2022-2023 above 2023-Present; `chronological()` = false; the C1 turn-2 reply then says "Founder above Founder" | **fail** |
| 5 | GPA when the sources disagree | Omitted, with "GPA omitted: conflicting source values need confirmation before use" | Omitted with the **same sentence**, in amber | pass |
| 6 | No leftover from the omitted GPA | Clean | An **empty bullet** where the 3.8 line was in Education, and an orphan **"ADDITIONAL / (registrar transcript)"** section where the 3.6 line was. The intake filed "Cumulative GPA: 3.6 (registrar transcript)" as an *experience* fact | **fail** |
| 7 | Contact placeholders visibly marked | Amber "[email · phone · LinkedIn to add]" | Amber "[email · phone · LinkedIn to add]" (fill 0.541 0.353 0) | pass |
| 8 | City and neighbourhood on the contact line | Printed | Not printed, although the profile's basics hold "Chicago, IL (Lincoln Park)" | **fail** |
| 9 | No added experience, skill or number | Uses the supplied draft only | Every bullet is verbatim from a confirmed fact. `inventedIn` finds only layout words ("LinkedIn", "Review", "Details") and pdfminer's split of the letter-spaced name ("AVE RY FI XT URE"); SQL was not added | pass |
| 10 | Skills block keeps Technical, Certifications and Interests | All three, with run-in labels | Technical and Certifications only. **Interests are lost**: the intake parser no longer files them as skills (the old "Skill: Golf" defect is gone) but keeps no fact for them either | **fail** |
| 11 | Review-draft note in the footer | Dotted gold rule: "Review draft built from the saved intake notes, not the original resume file. Facts unconfirmed; not for external submission." | Dotted gold rule: "Review draft for data analyst internships, built from the saved intake notes, not the original resume file. Details to confirm; not for external submission." | pass |
| 12 | The reply that accompanies the file (A.5 comparator reply) | "Here is the one-page PDF, ordered toward data analyst internships. It is built from your saved intake notes rather than the original resume file, so I left GPA off because the sources disagree and marked the contact details to fill in. I did not add experience; I reordered and tightened the supplied draft." | "Here is your one-page resume PDF for data analyst internships. / It's a general version, not written for one posting; send me a posting and I'll tailor it to that. / I used your saved resume intake, not the original file, kept every fact as written and added no experience. / Your GPA is left off because your resume shows two values (3.8 and 3.6). Which one is right? / Your name and contact details aren't on file, so the top shows placeholders. What name and email should go at the top of your resume?" | pass (adds the two narrow questions and B.1's general-versus-posting distinction) |
| 13 | The second real resume path agrees | n/a | `tailor_resume` (the brain's tool) refuses without a typed name and email, where the chat path prints placeholders | **fail** |

**Checks passed: Trainee 8 of 13.** The comparator meets checks 1-3, 5 and 7-12 as A.4 and A.5 describe it. Checks 4 and
6 cannot be judged from the description, and 13 does not apply to it.

Minor differences, not counted: the name prints in plum where A.4 says near-black; employer names end in a stray comma
("TEST Capital Partners,"); body type is 10.5 pt against about 9.5; there is no italic degree line. The chat path sends a
PDF only. The old production reply claimed a PDF and a DOCX. A.2 turn 3's download-link request got no link here, because
File pages are not configured in the test world. The reply's wording for that case is a shortfall (below).

### Item 3 verdict

Trainee now **matches the comparator on what A.4 and A.5 call out**: one page, delivered with the reply, GPA left off with
the comparator's own sentence, amber contact placeholders, no added experience, and the review-draft footer. Its
accompanying reply **beats** the comparator reply: it names the two GPA values, asks one question each for the GPA and
the contacts, and says it is a general version rather than a posting-specific one, as B.1 asks. It **falls short** on the
residue of the omitted GPA, the lost interests, the missing city line, the founder order and the two resume paths
disagreeing about contacts.

## Every place Trainee still falls short (both items)

1. **"No resume has been tailored in this chat" after it was sent.** In C1 t4 ("That is fine, give me the PDF.") and C3 t6,
   `career_document_delivery` does not see the resume task's delivered draft, although two PDFs were sent in the same
   thread. checkReply: 0 violations.
2. **A model instruction is shown to the person.** In A.2 resume turn 3, the File page error text is appended verbatim:
   "(file links aren't set up yet, so the person could not open it. Tell them it isn't available yet; do not claim it was
   made.)" (test world, no File base URL; any File-page failure takes this path). checkReply: 0 violations.
3. **A count word is read as part of the title.** C2 t1, "Find me five data analyst internships in Chicago", searches
   "five data analyst, five data analytics" and reports none found. A.2's "Find me 5 data analyst internships in Chicago"
   finds the Lakefront posting on the same board.
4. **Follow-ups claimed by the wrong handler.** In C2 t5 ("Why not that Stripe one?"), the Stripe file returns the
   software-engineering intern bar. In C5 t4 ("one question that will not sound copied"), a mock-interview question is
   returned. In C3 t6 ("send me the packet"), the reply is about a resume. In C4 t3 ("Now send it to Maya."), the reply
   says "no draft or list in this chat". In C4 t6 ("Make it warmer."), the reply says there is no draft and brings in a
   cover letter.
5. **Unsourced numbers are stripped, leaving an orphan.** C5 t5 delivers only "That is volume, not Stripe revenue." This
   is D-007 working (there is no source in the thread), but the reply should say that it has no sourced figure.
6. **Apply queue wording.** C3 t1 says three `boards.greenhouse.io` links are "not a Greenhouse, Lever, Ashby or Workday
   posting link I can open yet". This comes from the test board, but the sentence contradicts the link it prints.
7. **Resume file (item 3):** the empty bullet and orphan "ADDITIONAL (registrar transcript)", lost interests, no city
   line, founders out of order, and `tailor_resume` refusing where the chat path uses placeholders.
8. **Change description.** C1 t2: "I moved Private Equity Intern above M&A Intern; and Founder above Founder."
9. **Router-only fallback.** Without a model, 11 B.6 turns get the generic catch-all opener (`answers_first`).
10. **Rubric gap.** checkReply has no rule for a claim that contradicts the thread's own history (shortfalls 1 and 4) or
    for instruction text in a reply (shortfall 2). Its counts therefore rank Trainee above the target where the hand
    score does not.
11. **Not measured here:** a real Claude call on the 12 B.6 turns that reach the model, and the at-limit fallback (A.2
    search turn 2). Both need a run with a key and the owner's spend approval (CLAUDE.md budget rule).

## After the fixes (branch `ag/h2h-fixes`, 2026-11-10)

The same 35 turns were run again on the fixed branch with the same world, scripted model and context. The scratch driver was
rebuilt for this run (the first one was not committed): a fictional TEST resume (`Avery Fixture`, A.4's shape) pasted and
confirmed in chat ("Yes, that's my resume"), then each column's earlier turns, then the scored turns. On trunk `2f72517d` it
reproduces the totals above exactly (staged 4, router 12). The fixed turns are pinned in
`tests/architect/h2h-fixes-20261110.test.ts`, which runs them through the real handler.

### Totals, before and after

checkReply now has a 12th rule, `leaked_instruction` (text addressed to the model in a user reply). "Before" is trunk
scored with the old rubric, then with the new one.

| Column | checkReply before (old rubric) | before (new rubric) | after | A.5 by hand, before | after |
|---|---|---|---|---|---|
| Trainee, staged path, scripted model | 4 (A.2: 1, B.6: 3) | 7 (A.2: 4, B.6: 3) | **4** (A.2: 1, B.6: 3) | 140/175 (A.2 21/25, B.6 119/150) | **162/175** (A.2 23/25, B.6 139/150) |
| Trainee, router only (no model) | 12 (A.2: 1, B.6: 11) | 15 (A.2: 4, B.6: 11) | **12** (A.2: 1, B.6: 11) | not scored | not scored |
| Instinct target | 5 | 5 | 5 | 172/175 | 172/175 |

The three new-rule violations before were the leaked note in A.2 resume turn 3 ("the person could not", "Tell them it",
"do not claim it was"). The four violations left on the staged path are the same as before: A.2 search turn 2
(`blocker_named`), C3 t1 (`ends_at_decision`, apply-queue wording, shortfall 6) and C4 t4 (two, in Instinct's own text). The
#672 replay is unchanged on the router path (16 violations, 3 carry failures) and still 0 on the staged path; 18 of its 30
turns now deliver the model's answer, against 14.

### The turns that changed (staged path)

| Turn | Before | After | A.5 before / after |
|---|---|---|---|
| A.2 Resume 3 | "...couldn't be made (file links aren't set up yet, so the person could not open it. Tell them it isn't available yet; do not claim it was made.)." | "...There's no link this time: your private File page couldn't be made (file links aren't set up yet)." [PDF attached] | 3/5 / 5/5 |
| C1 t2 | "I moved Private Equity Intern above M&A Intern; and Founder above Founder." | "I moved Private Equity Intern above AI M&A Intern and Founder, TEST Resale Studio above Founder, TEST Tutoring Co. ..." | 4/5 / 5/5 |
| C1 t4 | "I can't send you a file yet because no resume has been tailored in this chat. ..." | "Here is the resume PDF for data analyst internships." [PDF attached] | 2/5 / 4/5 fails X (does not say it is still a review draft) |
| C2 t1 | "I checked five data analyst, five data analytics internships in Chicago ... none was found" | "From 1 live posting for data analyst in Chicago (internships) ... 1. Data Analyst Intern at Lakefront Transit Analytics ..." | 1/5 / 4/5 fails B (stock lines, as A.2 search 1) |
| C2 t3 | "I checked five data analyst, five data analytics internships in remote ..." | "I checked data analyst, data analytics internships in remote ..." | 4/5 / 4/5 fails C ("in remote") |
| C2 t5 | The Stripe file's software-engineering intern bar | The model's answer (Instinct's target) | 2/5 / 5/5 |
| C3 t6 | "I can't send you a file yet because no resume has been tailored in this chat. ..." | The model's answer (Instinct's target) | 3/5 / 5/5 |
| C4 t3 | "Which do you mean, and who should it go to? / Nothing was sent: there is no draft or list in this chat yet ..." | "Which Maya do you mean, and where should the resume PDF for data analyst internships go to reach them: an email address, or a conversation you have with them?" | 3/5 / 5/5 |
| C4 t6 | "I can't revise anything yet because there's no draft in this chat. / The cover-letter ask ..." | The model's warmer draft (Instinct's target) | 0/5 / 5/5 |
| C5 t4 | "Here is your question: Tell me about yourself and why this role. ..." | The model's question to ask (Instinct's target) | 3/5 / 5/5 |

The router-only path is unchanged for C2 t5, C3 t6, C4 t6 and C5 t4: those fixes hand the turn to the model, and without one
the router's own answer stands. C1 t4, C2 t1 and C4 t3 changed on both paths. C3 t6's target says "Here is the review
packet", and no packet exists in this thread. The scripted model only stands in for Claude here; a real call has to be
checked on that turn (shortfall 11).

### Item 3 after the fixes

The A.2 resume turn 1 file now prints the city line ("Chicago, IL (Lincoln Park)") above the amber placeholder. It has no
empty Education bullet and no "ADDITIONAL / (registrar transcript)" entry, and its founder roles run newest first
(Feb 2023 - Present above Jan 2022 - Dec 2023). It is still one page, US Letter (pdfinfo). Checks 4, 6 and 8 now pass.
Check 10 (Interests) passes again under the owner's ruling D-052 (PR #742): an Interests or Hobbies heading is read as the
person's interests, each item a draft fact ("Interest: Golf") awaiting their yes, never used before it is confirmed, and
printed on one "Interests:" line ("Interests: Golf, chess, Chicago architecture"). The pinned onboarding battery
(`tests/architect/scenarios/onboarding-generator.ts`) was amended under that ruling to expect the interests as entries;
Summary, Objective and Relevant Coursework stay unread. **12 of 13**. Check 13 (`tailor_resume` refuses without a typed name
and email) is unchanged. The resume
loop's `chronological()` is still false on this file, because the Python screening internship (Jan 2025) leads the AI M&A
internship (Jun 2025) by relevance. That is by design: the loop reports it and does not set a bar on it. The resume loop
stays at 81/81 made and 162/162 opened.

### Status of the shortfall list

Fixed: 1 (thread's own file), 2 (leaked instruction), 3 (count word), 4 (the five follow-ups), 7 except `tailor_resume`, 8,
and the instruction half of 10 (`leaked_instruction`). Open: 5 (orphan sentence after unsourced numbers), 6 (apply queue
wording), 7's `tailor_resume` refusal, 9 (router-only fallback), 10's contradiction-with-history rule, and 11 (a real Claude
run).

## Leftovers (branch `ag/h2h-leftovers`, 2026-11-10)

Pinned in `tests/architect/h2h-leftovers-20261110.test.ts`.

- **Check 13 (`tailor_resume` and the confirmed header).** The name and email at the top now come from the typed ones, else
  the confirmed resume header, piece by piece (`career_tailor.ts resumeContact`, 123 `headerOf`). A header with a name and no
  email (A.4's shape) keeps its name, and the tool asks only "What email should go at the top of your resume?";
  `set_resume_contact` takes the email alone when the confirmed record holds the name. With neither, both are asked, as
  before. The chat path asks the same piece. An unconfirmed header still counts for nothing. A name typed in chat with no
  email is still asked as both (WO-028/3 pins that sentence; open for an architect ruling).
- **"referrals".** The form-question map (`question_map.ts`, and the extension bundle built from it) and the introductions ask
  (`career_connector.ts`) read the plural as the singular.
- **C3 t6 ("Never mind, just send me the packet." with no packet).** The router answers it as code's
  (`career_packet_absent`, a code-owned intent in `career_staged.ts`): there is no application packet in this chat yet, and
  it prepares one for the role the person picks. The turn no longer reaches the model, so no model can say "Here is the
  review packet" on either path.
- **Item 9 copy.** An answer keyed to one posting (`job:`, other than an essay) is "Saved for your <company> application
  only; it isn't reused for another employer", and its question no longer promises "Answer it once and I won't ask
  again". Answers that travel keep "I won't ask this again".

## Tone gate (branch `ag/tone-gate`, 2026-11-10)

The owner asked whether Trainee answers as concisely as Instinct, in the same tone. `tests/architect/instinct-tone-gate.test.ts`
measures it: the same turns as above (A.2 as one thread, then B.6 continuations 1-5 in the head-to-head contexts) through the
real handler, staged brain on the scripted model, each reply scored against Instinct's reply for that turn. Rules: prose (list
items and bare links excluded) at most 1.2x Instinct's or Instinct's + 40; no internal words (the rubric's `internal` plus "the
record", "host", "write is not confirmed", and "packet" unless the person said it); no `boilerplate_tail`; no "I can't" /
"I couldn't" opener where Instinct's reply does the thing; `answers_first` reported. A.2 search turn 2 is not scored
(Instinct's reply is its daily AI limit, which Trainee does not have). Bar: every turn within length, 0 internal, 0 filler,
0 refusals; the turns still over the length bar are listed by name in the test's `OPEN`, asserted exactly.

| | TONE-GATE |
|---|---|
| Before (trunk `9ce8fbd4`) | `turns=34 within_length=24/34 internal=0 filler=0 refusals=2 answers_first=33/34 mean_chars=227 vs instinct=202` |
| After | `turns=34 within_length=32/34 internal=0 filler=0 refusals=0 answers_first=33/34 mean_chars=203 vs instinct=202` (the two open turns below) |

What changed in product code: the resume task says the general-version caveat, the GPA conflict and the contact question in
fewer words, and a correction no longer repeats the open questions; a bullet rewrite that fails its audit leads with the
outcome ("It stays as written: ..."); "send it to Maya" asks "Which Maya do you mean, and where should I send the resume
PDF?"; the send-choice question drops "Do you mean submit an application for"; the search list drops "Held to what you asked"
when nothing was left out and "Ranked by ..." when one row is listed; the apply queue says a reason shared by several postings
once; the no-packet reply is shorter; the eligibility answer opens "No, not confirmed yet" instead of "I can't say yet".

Open (named in the test): A.2 resume turn 3, where Instinct's 102 characters neither re-send the file nor answer the link ask;
C2 t3, the empty remote search, whose reply (R01 scope, R05 remote-only) is being rewritten on `ag/d054-fixes`.

### Same length as Instinct (branch `ag/mirror-length-and-gaps`, 2026-11-11)

Owner (2026-11-11): "Trainee's reply should be the same length" as Instinct's. The length bar is now a window, longer and
shorter both missing: prose within ±10% of Instinct's characters, or ±6 when Instinct's is under 60 (architect amendment to
the tone gate; `evals/mirror/score.ts` `length_match` uses the same window). Every other bar is unchanged.

| | TONE-GATE |
|---|---|
| Before (the new window on `ag/router-mirror-fixes`) | `turns=34 within_length=20/34 internal=0 filler=0 refusals=0 answers_first=33/34 mean_chars=207 vs instinct=202` |
| After | `turns=34 within_length=28/34 internal=0 filler=0 refusals=0 answers_first=33/34 mean_chars=210 vs instinct=202` |

Fixed in product code: a plain "give me the PDF" says what is still open on it and that it is a review draft; a pick of the PDF
from the two choices just asked gets only the file; an edit re-make names its source; a bullet kept as written names the count
to confirm; "send it to Maya" asks "Which Maya, and where should I send it?"; the two-choice question and the no-packet reply
lose their extra clause; the first PDF's general-version note is one short clause.

Open (named in the test's `OPEN`, each with its reason): A.2 R3 (Instinct's reply skips the link ask); A.2 S1 and C2 t1 (the
search summary's clauses are each pinned by another architect test: a ruling is needed on which goes); C2 t3 (the remote-only
empty search, pinned the same way); C3 t2 (Instinct prepares a packet this world cannot); C5 t5 (Instinct's figures have no
source in this run, D-007).

D-058 (architect, 2026-11-11) closed three of them: the search summary drops its freshness clause (on the File and in the turn's
proof), and the empty search takes the short form (scope and one widening; the refresh time and "Nothing was invented" in the
proof). `TONE-GATE turns=34 within_length=31/34 internal=0 filler=0 refusals=0 answers_first=33/34 mean_chars=198 vs
instinct=202`. Still open: A.2 R3, C3 t2, C5 t5, for the reasons above.
