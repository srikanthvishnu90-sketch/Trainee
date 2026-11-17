# Mass-apply conversations: after5-sub-eac5ede

Commit eac5edeb7e786d7aace3f0bdd7f54f2d44ed01ee · model subscription · 279 s · mean 9.62/10

| Scenario | Score | MUST | NICE | Failed checks |
|---|---|---|---|---|
| MA01 One message: every SWE internship in Chicago or remote I qualify for | 10.0 | 12/12 | 5/6 | card-fit |
| MA02 "apply to 50 data roles" when fewer exist | 10.0 | 13/13 | 4/6 | card-fit, offers-more |
| MA03 A vague ask | 8.0 | 4/4 | 0/1 | proposes-batch |
| MA04 Constraints: remote only, exclude a company | 10.0 | 15/15 | 5/6 | card-fit |
| MA05 A batch with questions only the person can answer | 10.0 | 14/14 | 5/6 | card-fit |
| MA06 Partial yes: "yes except 2 and 5" | 10.0 | 6/6 | 1/1 | none |
| MA07 "maybe" and a wrong count approve nothing | 10.0 | 6/6 | 0/0 | none |
| MA08 Status check mid-run | 10.0 | 14/14 | 4/6 | card-fit, fast-turns |
| MA09 A Workday link that needs the person's sign-in | 10.0 | 14/14 | 5/6 | card-fit |
| MA10 Duplicates: already applied, and one posting by two links | 10.0 | 5/5 | 0/0 | none |
| MA11 Follow-up: "apply to 20 more" | 10.0 | 5/5 | 1/1 | none |
| MA12 Proof and receipts | 10.0 | 4/4 | 1/1 | none |
| MA13 No resume yet | 10.0 | 2/2 | 1/1 | none |
| MA14 SCALE: 122 open postings in one ask | 6.3 | 5/8 | 1/2 | **all-prepared**, **approved-all**, **enqueued-once**, chat-fit-summary |
| MA15 LinkedIn link: refused plainly | 10.0 | 3/3 | 1/1 | none |

## Scale (MA14)

- ask to card (preparation, stub world): 28.3 s; yes turn with sends: 9.2 s
- card messages: 9, longest 3750 characters
- approved 25, reached the employer 20, distinct postings sent 20
