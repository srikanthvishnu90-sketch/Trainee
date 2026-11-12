MIRROR WA-1 live-6, five similarity checks: 1/26 match; task 16, process 20, shape 1 (length 2, answers first 17), honesty 19, voice 20; 24 turns measured, C21f and C23 not run (cap)

| Turn | Route | Task | Process | Shape | Honesty | Voice | Instinct chars | Trainee chars | live-5 chars | Match | live-5 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | model | FAIL | FAIL | FAIL | FAIL | ok | 396 | 1123 | 502 | - | fails task, process, shape |
| C2 | model | ok | ok | FAIL | ok | ok | 361 | 364 | 507 | - | fails process, shape |
| C3 | router | FAIL | ok | FAIL | ok | FAIL | 396 | 229 | 189 | - | fails task, process, shape, voice |
| C4 | model | ok | ok | FAIL | ok | ok | 432 | 756 | 598 | - | fails shape |
| C5 | model | ok | ok | ok | ok | ok | 262 | 268 | 275 | MATCH | MATCH |
| C6 | model | FAIL | FAIL | FAIL | ok | ok | 430 | 517 | 481 | - | fails task, shape |
| C5f1 | model | ok | ok | FAIL | ok | ok | 312 | 544 | 766 | - | fails shape |
| C5f2 | model | FAIL | FAIL | FAIL | FAIL | FAIL | 380 | 502 | 917 | - | fails shape |
| C7 | model | ok | ok | FAIL | ok | ok | 459 | 654 | 573 | - | fails shape |
| C8 | model | ok | ok | FAIL | ok | FAIL | 1240 | 1746 | 1458 | - | fails shape |
| C9 | model | FAIL | ok | FAIL | FAIL | FAIL | 1144 | 0 | 401 | - | fails task, shape, voice |
| C10 | model | ok | ok | FAIL | ok | ok | 346 | 1153 | 501 | - | fails task, process, shape |
| C11 | model | ok | ok | FAIL | ok | ok | 458 | 1173 | 558 | - | fails process, shape |
| C12 | model | ok | ok | FAIL | ok | ok | 478 | 870 | 654 | - | fails shape, honesty |
| C13 | model | ok | ok | FAIL | FAIL | ok | 109 | 217 | 202 | - | fails process, shape |
| C14 | model | ok | ok | FAIL | ok | ok | 178 | 230 | 219 | - | fails process, shape |
| C15 | model | ok | ok | FAIL | ok | ok | 568 | 772 | 696 | - | fails shape |
| C16 | model | ok | ok | FAIL | ok | ok | 383 | 1055 | 502 | - | fails task, process, shape, honesty |
| C17 | model | ok | ok | FAIL | ok | ok | 563 | 1070 | 1182 | - | fails shape |
| C18 | model | ok | ok | FAIL | ok | ok | 135 | 222 | 245 | - | fails task, process, shape, honesty, voice |
| C19 | model | FAIL | ok | FAIL | ok | ok | 792 | 543 | 495 | - | fails task, process, shape, honesty, voice |
| C20 | model | FAIL | ok | FAIL | FAIL | ok | 358 | 867 | 246 | - | fails task, process, shape, honesty, voice |
| C21 | model | ok | ok | FAIL | ok | ok | 241 | 275 | 321 | - | fails task, process, shape, honesty, voice |
| C22 | model | FAIL | FAIL | FAIL | ok | ok | 410 | 172 | 247 | - | fails task, process, shape, honesty, voice |
| C21f | not run | FAIL | FAIL | FAIL | FAIL | FAIL | 412 | - | 247 | - | fails task, process, shape, honesty, voice |
| C23 | not run | FAIL | FAIL | FAIL | FAIL | FAIL | 130 | - | 247 | - | fails task, process, shape, honesty, voice |

## Cause of each failure (G-ruling)

| Turn | Cause |
|---|---|
| C1 | G11/G13 (no File); G1/D-007 (add_profile_fact still attempted on a question); G4 (pay range from the wrong location); G3 (1,123 chars) |
| C2 | G2: code's label 'Draft, not sent:' comes before the draft, so the answers-first check fails; length matched (364 vs 361) |
| C3 | G14 world (2 postings, one returned); G3 (229 vs 396); voice: code's search template (G1/G2) |
| C4 | G3: an advice answer 756 vs 432; D-065's shortening pass did not bring it under the bound (rejected or not run) |
| C6 | G14/G1: the brain did not call read_application_mail (regression from live-5); G3 (517 vs 430) |
| C5f1 | G3 (544 vs 312) |
| C5f2 | G3 enforcement (D-065 (1)): shortenedOk checks figures, links, placeholders and the boundary, not that the output is a rewrite of the reply; a meta-reply passed |
| C7 | G3 (654 vs 459) |
| C8 | G3 (1,746 vs 1,240; the 'everything' kind's 1,320 bound not reached); voice: a record id reached the person (G2/G5 wording) |
| C9 | G3/G4 research reply (D-065 (1b) parts check + enforceMarketReply): enforceMarketReply returns "" when the result is format 'file' and no sentence is on record (shown at $0 with a synthetic result); the run does not record which path ran |
| C10 | G3 (1,153 vs 346): a turn whose tool wrote a file is exempt from the shortening pass |
| C11 | G3 (1,173 vs 458) |
| C12 | G3 (870 vs 478) |
| C13 | G3 (217 vs 109); D-007/G10: the draft invents a prior conversation |
| C14 | G3 (230 vs 178) and G2 (code's 'Draft, not sent:' label first) |
| C15 | G3 (772 vs 568) |
| C16 | G3 (1,055 vs 383; a tool that wrote a File is exempt) and G2 (answers-first check) |
| C17 | G3 (1,070 vs 563) |
| C18 | G3 (222 vs 135): a re-check answer is held to the 'answer' kind's 500, not a short-answer length |
| C19 | G14 (public people search returned nothing on the live web); G3 (543 vs 792) |
| C20 | G11/D-063 (2): tailor_resume's condense drops the entry; G7/D-007 (a number the person never gave); G3 (867 vs 358) |
| C21 | G3 (275 vs 241, 10% is 24) and the answers-first heuristic |
| C22 | G7 (the thread is memory: PayPal's pay read in C11 unused) and G4/G14 (the research reader's pages did not open or support a figure); G3 (172 vs 410) |
| C21f | not measured: the cap (D-060 round budget) was reached after C22 |
| C23 | not measured: the cap (D-060 round budget) was reached after C22 |

## The five worst pairs

### C9: Empty reply after research_market (G3/G4 research reply path; enforceMarketReply can return "").

**Instinct:**

> Pay: Citadel's official university-graduate SWE posting lists $235k-$300k base plus a discretionary bonus, not guaranteed total compensation. It currently lists New York, Miami, Greenwich and Houston, not Chicago.
>
> https://www.citadel.com/careers/details/software-engineer-university-graduate-us/
>
> Interviews: Citadel describes a 45-minute first round, a second round with three 45-minute interviews, then team matching, with the overall process taking roughly eight weeks. Expect coding and behavioral questions; candidate accounts also describe an online assessment, but I wouldn't assume every candidate gets an identical sequence.
>
> https://www.citadel.com/careers/career-perspectives/our-engineering-interview-process/
>
> Culture: my read is high upside with a real pressure risk, so I'd interview the manager as hard as they interview you. Anonymous accounts describe demanding hours and performance pressure, but they're anecdotes, not proof every team operates that way. Ask about normal hours, on-call, turnover and what happens when someone misses expectations.
>
> https://www.reddit.com/r/quant/comments/10d7lv1/why_do_people_say_citadel_has_bad_wlb/
>
> One important distinction: Citadel and Citadel Securities are different employers, so don't mix their offer numbers or team reputations. This reporting explains the engineering differences, though it's from 2022 rather than a current culture audit.
>
> https://www.efinancialcareers.com/news/2022/11/citadel-citadel-securities-engineers

**Trainee:**

> (empty reply)

### C5f2: The length condenser's refusal replaced the code review (D-065 G3 pass; shortenedOk has no same-content check).

**Instinct:**

> It returns 5 for the example, but an empty list or a list with no unique number raises StopIteration instead of returning None. Use next((n for n in nums if counts[n] == 1), None), and replace the list comprehension with a normal counting loop so you don't build an unused list. Follow-up: if the input is a generator you can only traverse once, how would you adapt your approach?

**Trainee:**

> It looks like there was no text to rewrite, just a request to redo the code. If you meant to send a career assistant's message, please paste it and I'll shape it into a short text. As for the request itself, I haven't written the first repeated value version yet, and I haven't described an O(1)-space idea either. I can do both if you'd like, starting with the idea so you can approve it before I code it, with the None case handled and the four-line set version you described. Want me to start there?

### C6: Gmail not read: no read_application_mail, so 'nothing on record' (G14/G1; regression from live-5).

**Instinct:**

> Yes: your Gmail confirmations show past applications to Bank A, Payroll Co, Coffee Co, Grill Co, Gym Co, Shirt Co, Startup Co, Finance Co and Apparel Co. I didn't find confirmed SWE internship submissions or application confirmations since August across your three Gmail accounts; tonight's five roles were research only, and submissions without confirmation emails could be missing. Want me to keep a running application tracker?

**Trainee:**

> No, nothing on record yet. I checked your applications, and there are none queued, prepared, sent or failed. The PayPal Software Engineer Intern - Summer 2027 posting I showed you is only a search result, not an application. Applications you sent on your own outside Trainee aren't checked here, so tell me if you've applied anywhere and I'll record it. Your Python question is still open whenever you want to give me your approach.
> 
> Do you want me to save the PayPal posting to your tracker so it's tracked from here?

### C22: No figure, though PayPal's Chicago pay was read in C11 (G7), and no get_posting (process); research pages did not open (G14).

**Instinct:**

> For non-trading Chicago SWE internships, I'd use roughly $25-$50/hour as a practical benchmark, not a measured market median. PayPal's current posting lists $28-$49/hour; self-reported examples include Relativity at $32, CME at $34 and RSM at $37.50, though those reports can lag. Compare base hourly pay separately from housing and relocation, and don't use elite trading-firm packages as the normal baseline.
>
> https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586
>
> https://www.levels.fyi/internships/Relativity/Software-Engineer-Intern/
>
> https://www.levels.fyi/internships/CME-Group/Software-Engineer-Intern/
>
> https://www.levels.fyi/internships/RSM-US/Software-Engineer-Intern/

**Trainee:**

> I couldn't confirm a going rate for Chicago SWE interns, because the pages I tried to read didn't open or didn't support a figure, so I have no verified number to give you.

### C1: 1 posting and no File, 2.8x Instinct's length, add_profile_fact still attempted on a question (G11, G3, G1/D-007).

**Instinct:**

> Start with PayPal, Pinterest, Amplify and the Chicago Fed; Infleqtion is a fifth option, but a stretch because of its quantum focus. All five have live postings with basic eligibility that fits you, though that doesn't guarantee full qualification. Your first priorities are fixing the outdated GPA on your resume and applying to these roles; the links and weekly plan are in the file.
>
> https://[Instinct File link]

**Trainee:**

> The search found one posting, PayPal's Software Engineer Intern - Summer 2027 in Chicago, IL, at $32 - $55 hourly. It scores as a Reach, not a role match, and no remote postings came up.
> 
> https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586
> 
> Your Python and React match it. SQL is on your resume, but the search found no evidence for it on your profile, so add a concrete SQL use to a bullet. My plan, from your record and my own judgement:
> 
> 1. **Resume:** lead with the SWE-relevant work (Pixelforge's 70+ React sites, Crestline's Python tooling, Harbor Global's AI tooling) and cut the outdated 3.9 GPA.
> 2. **Apply this week:** postings for summer 2027 are going up now, so widen to many employers, not one.
> 3. **Referrals:** message Lakeshore alumni at the companies you target, since a referral beats a cold application.
> 4. **Interview prep:** practice coding questions out loud a few times a week.
> 
> Two things on your resume are still open: the Harbor Global dates and whether it's "Crestline Partners" or "Crestline Search Partners". Please check both before anything goes out. Nothing was sent or submitted.
> 
> Do you want me to tailor your resume to the PayPal posting first?
