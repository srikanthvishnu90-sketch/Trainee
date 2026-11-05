# Trainee vs Opus 5.5 reference: trunk-4158a1a

SHA `4158a1a38c488b9f277f44fd3059d4b7a6bf7999` · references 208/208 · judge haiku (claude CLI, subscription) · 0 CLI calls this run (cap 20)

> Quality metric. Win = Trainee's reply judged better than the Opus 5.5 reference overall; loss = worse. Only turns answered by code (router or code-first) are compared: a staged-brain turn carries the benchmark's scripted text, so it is "not comparable" here.

## Overall

| state | judged | win | tie | loss | not comparable (scripted brain) |
|---|---|---|---|---|---|
| empty | 40 | 0 | 1 | 39 | 64 |
| seeded | 42 | 1 | 0 | 41 | 62 |

## By dimension (all judged records)

| dimension | win | tie | loss |
|---|---|---|---|
| ask: understood the real ask, including its constraints and negations ("do not apply", "for review only", "without starting one") | 1 | 23 | 58 |
| delivered: delivered every item the person asked for (links, counts, a File or its content, a draft, a direct answer) | 3 | 21 | 58 |
| correct: correct, with no invented facts about the person, employers, sources or what happened | 3 | 16 | 63 |
| texting: brief and fit for a text message (no internal jargon, no wall of text, no filler) | 9 | 11 | 62 |
| next: ends with one clear, useful next step or question | 13 | 17 | 52 |

## By feature

| feature | win | tie | loss | not comparable |
|---|---|---|---|---|
| C Live beta tasks (C01-C04) | 0 | 0 | 8 | 0 |
| A1 Mass apply | 0 | 0 | 8 | 0 |
| A2 Approval binding | 0 | 0 | 2 | 6 |
| A3 Cloud apply | 0 | 0 | 5 | 3 |
| A4 Extension (excluded) | 0 | 0 | 2 | 6 |
| A5 Answer bank | 0 | 0 | 4 | 4 |
| A6 Resume tailoring | 0 | 0 | 6 | 2 |
| A7 Written answers | 0 | 0 | 0 | 8 |
| A8 Ingestion freshness | 0 | 0 | 2 | 6 |
| A9 Search | 0 | 0 | 6 | 2 |
| A10 Alerts | 0 | 0 | 2 | 6 |
| A11 Networking | 0 | 0 | 2 | 6 |
| A12 Outreach | 0 | 0 | 4 | 4 |
| A13 Warm intros | 0 | 0 | 0 | 8 |
| A14 Tracking | 0 | 1 | 5 | 2 |
| A15 Interview prep | 0 | 0 | 8 | 0 |
| A16 Offers and guidance | 0 | 0 | 2 | 6 |
| A17 Chat and guards | 1 | 0 | 1 | 6 |
| A18 Memory | 0 | 0 | 2 | 6 |
| A19 Onboarding | 0 | 0 | 2 | 6 |
| A20 Channels | 0 | 0 | 2 | 6 |
| A21 Digest | 0 | 0 | 2 | 6 |
| A22 Privacy | 0 | 0 | 2 | 6 |
| A23 Portal codes | 0 | 0 | 1 | 7 |
| A24 Apply by email | 0 | 0 | 0 | 8 |
| A25 Measurement | 0 | 0 | 2 | 6 |

## Records

| case | state | layer | overall | ask | delivered | correct | texting | next | why |
|---|---|---|---|---|---|---|---|---|---|
| A1.1 | empty | router | loss | loss | loss | loss | loss | loss | Reply A lists ten real Chicago board links that match the request, while Reply B wrongly claims no postings exist. |
| A1.1 | seeded | router | loss | loss | loss | loss | tie | loss | Reply B lists ten real Chicago postings with URLs, whereas Reply A wrongly says the board has no matches despite several Chicago customer support roles. |
| A1.2 | empty | code_first | loss | tie | tie | tie | win | tie | Both correctly refuse to apply with no saved list, but Reply A also states the resume requirement and the per-item approval rule. |
| A1.2 | seeded | code_first | loss | loss | loss | loss | loss | loss | Reply A respects the approval constraint and asks about Northwind, while Reply B claims 8 queued from a 10-role list and is dense with jargon. |
| A1.3 | empty | router | loss | tie | tie | tie | loss | tie | Both correctly say there is no list to skip, but A repeats the no-list point twice while B is tighter and clearly says nothing was changed. |
| A1.3 | seeded | router | loss | loss | loss | loss | tie | loss | Reply B actually removes Lakeview and lists the remaining nine roles, while Reply A ignores the skip and offers to tailor for Lakeview. |
| A1.4 | empty | router | loss | tie | tie | loss | loss | tie | A says it will start a batch without noting that no resume exists, and uses jargon like 'read back'; B states the account is empty and names the resume and role |
| A1.4 | seeded | router | loss | loss | loss | loss | tie | loss | Reply A shows per-role progress consistent with the prior nine-role batch, while Reply B says no batch can be found and shows nothing. |
| A2.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A2.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A2.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A2.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A2.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A2.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A2.4 | empty | router | loss | loss | tie | loss | loss | win | B directly acknowledges the 'no' and says it stays unsent, while A is longer and drifts into process claims, though A ends with a useful question. |
| A2.4 | seeded | router | loss | loss | loss | loss | loss | loss | Reply A acknowledges the stop, confirms the held $27 draft was not sent, and asks whether to keep or delete it, while Reply B ignores the draft and gives a gene |
| A3.1 | empty | router | loss | loss | loss | tie | win | loss | B covers both missing inputs (posting and resume), the confirmed-facts rule, and the approval gate, while A is shorter but asks for less. |
| A3.1 | seeded | router | loss | loss | loss | loss | loss | loss | Reply A invents a 'backend role' the person never mentioned, while Reply B accurately lists the three roles from the board with URLs and asks which one to prepa |
| A3.2 | empty | router | loss | tie | tie | loss | loss | loss | A invents a handoff-link and ticket mechanism and uses jargon, while B correctly says nothing is in progress and asks for the posting. |
| A3.2 | seeded | router | loss | tie | tie | win | loss | tie | Reply A is long and full of internal jargon (ticket, handoff link, minted), while Reply B briefly states the CAPTCHA rule and that the person completes it thems |
| A3.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A3.3 | seeded | router | loss | loss | loss | loss | loss | loss | Reply A keeps the person in control of sign-in and says no passwords in chat, whereas Reply B has the agent create accounts and vault passwords in jargon-heavy  |
| A3.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A3.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A4.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A4.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A4.2 | empty | router | loss | loss | loss | loss | loss | loss | B directly answers that applications run in the cloud browser with the stated limits, while A answers a LinkedIn question that was not asked and invents a sign- |
| A4.2 | seeded | router | loss | loss | loss | loss | loss | loss | Reply B directly answers 'yes' and explains the cloud-browser flow with the approval and sign-in limits, while Reply A is garbled, talks about connecting Linked |
| A4.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A4.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A4.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A4.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A5.1 | empty | router | loss | tie | loss | tie | tie | win | B gives a fuller, accurate field list and states that no answers are saved, while A's list is thinner but ends with a clear next step. |
| A5.1 | seeded | router | loss | tie | loss | tie | win | win | Reply A gives a fuller, resume-grounded list of typical fields, while Reply B is shorter, opens with an awkward echo fragment, and ends with a clear question to |
| A5.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A5.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A5.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A5.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A5.4 | empty | router | loss | loss | loss | loss | loss | loss | B invents a packet to hold and jargon about a record write, while A correctly says nothing is saved and asks for the answer. |
| A5.4 | seeded | router | loss | loss | loss | loss | loss | loss | Reply B correctly notes no sponsorship answer is saved yet and asks a clear yes/no question, while Reply A invents a prepared packet to hold and uses jargon lik |
| A6.1 | empty | router | loss | tie | loss | tie | tie | tie | B explains there is nothing to tailor, asks for the resume, and accurately points to real Chicago and remote board roles, which A omits. |
| A6.1 | seeded | router | loss | loss | loss | loss | loss | loss | Reply B tailors for customer support from confirmed facts, while Reply A tailors for an unrelated Synthco software role and invents a PDF, parse check, and post |
| A6.2 | empty | router | loss | loss | loss | loss | loss | loss | B answers an imagined outreach question with invented product claims and a shortlist offer, while A directly confirms SQL will not be added unless the person co |
| A6.2 | seeded | router | loss | loss | loss | loss | loss | loss | Reply B honors the 'do not invent SQL' constraint and cites the real PostgreSQL lines, while Reply A refuses and then drifts into outreach and Gmail talk unrela |
| A6.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A6.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A6.4 | empty | router | loss | tie | tie | tie | tie | tie | Both say no PDF exists yet, but B states the review-and-approve order and avoids A's redundant request to name the role again. |
| A6.4 | seeded | router | loss | loss | loss | loss | loss | win | Reply A honestly says it cannot make a PDF and provides the tailored resume inline as a File, while Reply B claims a PDF is attached when none exists. |
| A7.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A7.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A7.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A7.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A7.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A7.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A7.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A7.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A8.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A8.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A8.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A8.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A8.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A8.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A8.4 | empty | router | loss | loss | loss | loss | loss | loss | B claims a live and snapshot search that cannot happen in this text-only turn, while A honestly says open status cannot be confirmed and asks for the role. |
| A8.4 | seeded | router | loss | loss | loss | loss | loss | loss | Reply A lists the Chicago postings from the board and honestly says it cannot re-verify they are open, while Reply B falsely claims a live board and snapshot ch |
| A9.1 | empty | router | loss | loss | loss | loss | loss | loss | Reply A lists three real Chicago entry-level postings with URLs, while Reply B wrongly says the board has no match even though several exist. |
| A9.1 | seeded | router | loss | loss | loss | loss | loss | loss | Reply B lists three real Chicago entry-level postings from the board with URLs, while Reply A wrongly claims the board has no matches. |
| A9.2 | empty | router | loss | loss | loss | loss | loss | loss | Reply A gives real remote (US) support postings with URLs, while Reply B wrongly says the board has no remote match and garbles the request. |
| A9.2 | seeded | router | loss | loss | loss | loss | loss | loss | Reply A honours the remote-only constraint with three board links, offers the rest, and flags the on-site Chicago roles; Reply B claims unverified pay details,  |
| A9.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A9.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A9.4 | empty | router | loss | loss | loss | loss | loss | loss | Reply A correctly says no postings exist for ZZZSynthetic999 and offers real alternatives, while Reply B mangles the company name and gives an irrelevant templa |
| A9.4 | seeded | router | loss | tie | tie | loss | loss | tie | Reply B garbles the company name ("company does exist zzzsynthetic999"), adds an unrequested "in Chicago" constraint and an unsupported snapshot claim, whereas  |
| A10.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A10.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A10.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A10.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A10.3 | empty | router | loss | loss | loss | tie | loss | loss | Reply A directly explains how to pause alerts and that none exist yet, while Reply B mostly explains how to create a watch and uses jargon like 'watch profile'. |
| A10.3 | seeded | router | loss | loss | loss | tie | loss | win | Reply A directly explains how to pause alerts and notes none exist, while Reply B never answers how to pause and uses internal jargon like "watch profile", thou |
| A10.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A10.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A11.1 | empty | code_first | loss | loss | loss | tie | win | loss | Reply A clearly says alumni search is not possible and offers a workable review-first alternative, while Reply B only asks for a school and never addresses the  |
| A11.1 | seeded | code_first | loss | loss | win | loss | loss | loss | Reply B asks which company is meant and stays brief, while Reply A adds unverifiable specifics (72-hour link, 40 rows per message, no attachments) and a long mu |
| A11.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A11.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A11.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A11.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A11.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A11.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A12.1 | empty | code_first | loss | loss | loss | tie | win | loss | Reply A delivers a review-only placeholder draft and asks for details, while Reply B refuses to draft at all and adds unrequested LinkedIn export steps. |
| A12.1 | seeded | code_first | loss | loss | loss | win | tie | loss | Reply B delivers a review-only networking draft with placeholders and resume facts, though it wrongly says 'last summer' for a summer 2025 internship, whereas R |
| A12.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A12.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A12.3 | empty | code_first | loss | loss | tie | loss | loss | win | Reply B acknowledges the no-email constraint and states nothing was sent, while Reply A ignores it, pivots to adding contacts, and cites an unverified LinkedIn  |
| A12.3 | seeded | code_first | loss | loss | loss | loss | loss | win | Reply B directly confirms that nothing is sent and that the counter stays an unsent draft, while Reply A ignores the 'no email should be sent' constraint and on |
| A12.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A12.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A13.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A13.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A13.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A13.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A13.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A13.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A13.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A13.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A14.1 | empty | router | tie | tie | tie | tie | tie | tie | Both correctly report an empty tracker and offer a clear next step, with comparable brevity and no invented facts. |
| A14.1 | seeded | router | loss | tie | loss | tie | win | loss | A gives the full status with counts and a clear follow-up question; B is shorter, but its 'say find jobs' next step is stale because the search has already run. |
| A14.2 | empty | code_first | loss | loss | loss | loss | loss | loss | Reply B invents a product name ('Trainee') and a 30-day window, while Reply A accurately describes the empty state and gives a concrete next step. |
| A14.2 | seeded | code_first | loss | loss | loss | loss | tie | loss | A answers narrowly, leaves out the offer, counter draft and next step, and invents a 30-day scope and a 'Trainee' product name; B covers the real status accurat |
| A14.3 | empty | code_first | loss | loss | tie | tie | loss | tie | Reply B answers the question directly in a few sentences, whereas Reply A buries the answer under a long, jargon-heavy counting methodology. |
| A14.3 | seeded | code_first | loss | loss | loss | loss | loss | loss | A directly answers 'nothing sent' and notes the pending counter email is unsent; B adds an invented counting methodology (queues, receipts, UTC day) that is not |
| A14.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A14.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A15.1 | empty | router | loss | loss | loss | loss | loss | loss | Reply A delivers the requested five questions and 30-minute plan as inline content and honestly notes no File link exists, while Reply B gives only a few questi |
| A15.1 | seeded | router | loss | loss | loss | loss | loss | loss | Reply A delivers the requested one-page File with five questions and a 30-minute plan, grounded in the resume. Reply B gives a jargon-heavy brief with no File,  |
| A15.2 | empty | router | loss | tie | win | loss | loss | tie | Reply A invents product behavior ('sleep is a scored input', 'I will score it') and uses jargon, while Reply B honors the no-invention constraint and asks the o |
| A15.2 | seeded | router | loss | loss | win | loss | loss | loss | Reply A correctly asks for the missing company, role, and format and promises no invented facts, while Reply B delivers more but adds unsupported claims like 's |
| A15.3 | empty | router | loss | tie | tie | loss | loss | loss | Both explain that voice is unavailable and offer a text mock, but B adds internal build detail ('no speech path in this build') and A's closing question moves t |
| A15.3 | seeded | router | loss | tie | tie | loss | loss | loss | Both clearly say voice mocks aren't available and offer a text mock, but B avoids internal jargon ('this build') and claims about scoring that A asserts without |
| A15.4 | empty | router | loss | tie | tie | loss | loss | tie | B gives a concrete practice question and a clear reply instruction, while A asks for an answer 'out loud' in a text chat. |
| A15.4 | seeded | router | loss | loss | tie | tie | loss | tie | Reply A's question is tailored to customer support and grounded in the resume, while Reply B's generic question comes wrapped in jargon like 'rubric' and 'drill |
| A16.1 | empty | router | loss | tie | loss | loss | tie | tie | A lists the real board postings with URLs, whereas B cites an unseen 'knowledge base' source and gives no postings. |
| A16.1 | seeded | router | loss | loss | loss | loss | loss | loss | Reply A honestly flags that the resume shows no retail work and gives board links, while Reply B invents a source citation and date and cites no postings. |
| A16.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A16.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A16.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A16.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A16.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A16.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A17.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A17.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A17.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A17.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A17.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A17.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A17.4 | empty | code_first | loss | tie | tie | loss | tie | win | A honestly notes there is no earlier request on this empty account, while B concedes a miss it cannot verify, though B's next question is more specific. |
| A17.4 | seeded | code_first | win | win | tie | win | win | win | Reply A admits the miss and asks what was wanted without guessing, while Reply B presumes an interpretation and re-lists jobs the person already saw. |
| A18.1 | empty | router | loss | tie | tie | loss | loss | loss | A says nothing is saved and offers to read facts back for confirmation first, while B claims facts are recorded immediately, which conflicts with the approval r |
| A18.1 | seeded | router | loss | loss | loss | loss | loss | loss | Reply B answers about the person's job preferences from the chat, while Reply A recounts resume entry counts, repeats itself, and ignores the preferences. |
| A18.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A18.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A18.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A18.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A18.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A18.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A19.1 | empty | router | loss | tie | tie | tie | loss | tie | A's numbered two-item list is cleaner and easier to scan than B's dense paragraph with filler. |
| A19.1 | seeded | router | loss | loss | loss | loss | loss | loss | Reply B correctly notes the confirmed resume already exists and lists the real missing inputs, while Reply A asks the person to paste a resume they already conf |
| A19.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A19.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A19.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A19.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A19.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A19.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A20.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A20.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A20.2 | empty | router | loss | loss | loss | loss | loss | loss | Reply B answers whether the search can continue and asks for role and location; Reply A talks about a company-file library the person never asked about. |
| A20.2 | seeded | router | loss | loss | loss | loss | loss | tie | Reply A directly confirms the saved search and held counter draft, while Reply B answers an unrelated question about company files. |
| A20.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A20.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A20.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A20.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A21.1 | empty | router | loss | loss | loss | loss | loss | tie | Reply A explains what a weekly digest contains; Reply B shows an empty digest with counts instead of answering the question. |
| A21.1 | seeded | router | loss | loss | loss | loss | loss | win | Reply A explains what a digest contains, while Reply B reports a digest with counts even though no digest or applications exist on record. |
| A21.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A21.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A21.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A21.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A21.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A21.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A22.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A22.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A22.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A22.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A22.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A22.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A22.4 | empty | router | loss | tie | tie | loss | loss | win | Both explain deletion without doing it, but Reply A adds an unsupported claim about transcripts and uses more jargon, while Reply B is shorter and accurately no |
| A22.4 | seeded | router | loss | tie | loss | loss | loss | win | Reply A names the specific items a delete would remove, while Reply B invents erase semantics such as transcript and audit-record exclusion and uses internal ja |
| A23.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A23.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A23.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A23.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A23.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A23.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A23.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A23.4 | seeded | router | loss | loss | loss | loss | loss | loss | Reply B gives the right safety answer (don't enter another person's password, verify the real site, sign in with your own account), while Reply A talks about cr |
| A24.1 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A24.1 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A24.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A24.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A24.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A24.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A24.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A24.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A25.1 | empty | code_first | loss | loss | loss | loss | loss | tie | Reply A gives a direct zero count; Reply B buries it in a long, filler-heavy explanation of its counting method. |
| A25.1 | seeded | code_first | loss | tie | tie | loss | loss | loss | Both answer zero, but Reply A pads the answer with an invented counting methodology while Reply B is brief and points to the unsent draft awaiting review, thoug |
| A25.2 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A25.2 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A25.3 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A25.3 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A25.4 | empty | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| A25.4 | seeded | staged_brain | not comparable (scripted brain) | - | - | - | - | - |  |
| C01 | empty | router | loss | loss | loss | loss | loss | loss | Reply B gives three real Chicago board links, while Reply A is garbled and wrongly says no postings exist. |
| C01 | seeded | router | loss | loss | loss | loss | loss | loss | Reply B lists three real Chicago customer support links and respects the no-contact limit; Reply A is garbled and wrongly claims no matches exist. |
| C02 | empty | router | loss | loss | loss | loss | loss | win | Reply B lists six real Chicago healthcare roles and training options, while Reply A talks about a company file and answers a different question. |
| C02 | seeded | router | loss | loss | loss | loss | win | loss | Reply A gives the healthcare links, training ideas, and a resume-gap question; Reply B is garbled, starts mid-sentence, and talks about a company file instead. |
| C03 | empty | router | loss | loss | loss | loss | loss | loss | Reply B delivers the requested one-page File with five questions and a 30-minute plan and confirms the profile was unchanged, while Reply A delivers only three  |
| C03 | seeded | router | loss | loss | loss | loss | win | loss | Reply B delivers the requested one-page File with five questions and a 30-minute plan, while Reply A gives only three questions and offers a mock instead. |
| C04 | empty | router | loss | loss | loss | loss | loss | loss | Reply B answers whether to counter and gives a clear draft for review, while Reply A is an unfilled template with 'the firm' placeholders and no answer. |
| C04 | seeded | router | loss | loss | loss | loss | loss | loss | Reply A answers whether to counter and gives a usable draft held for approval, while Reply B is garbled and its draft asks for $24 rather than a counter. |
