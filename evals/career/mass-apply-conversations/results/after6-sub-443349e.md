# Mass-apply conversations: after6-sub-443349e

Commit 443349eb7ba5562f3a0d3a3c22212ab03ee32541 · model subscription · 128 s · mean 9.62/10

| Scenario | Score | MUST | NICE | Failed checks |
|---|---|---|---|---|
| MA01 One message: every SWE internship in Chicago or remote I qualify for | 10.0 | 12/12 | 6/6 | none |
| MA02 "apply to 50 data roles" when fewer exist | 10.0 | 13/13 | 5/6 | offers-more |
| MA03 A vague ask | 8.0 | 4/4 | 0/1 | proposes-batch |
| MA04 Constraints: remote only, exclude a company | 10.0 | 15/15 | 6/6 | none |
| MA05 A batch with questions only the person can answer | 10.0 | 14/14 | 6/6 | none |
| MA06 Partial yes: "yes except 2 and 5" | 10.0 | 6/6 | 1/1 | none |
| MA07 "maybe" and a wrong count approve nothing | 10.0 | 6/6 | 0/0 | none |
| MA08 Status check mid-run | 10.0 | 14/14 | 6/6 | none |
| MA09 A Workday link that needs the person's sign-in | 10.0 | 14/14 | 6/6 | none |
| MA10 Duplicates: already applied, and one posting by two links | 10.0 | 5/5 | 0/0 | none |
| MA11 Follow-up: "apply to 20 more" | 10.0 | 5/5 | 1/1 | none |
| MA12 Proof and receipts | 10.0 | 4/4 | 1/1 | none |
| MA13 No resume yet | 10.0 | 2/2 | 1/1 | none |
| MA14 SCALE: 122 open postings in one ask | 6.3 | 5/8 | 1/2 | **all-prepared**, **approved-all**, **enqueued-once**, chat-fit-summary |
| MA15 LinkedIn link: refused plainly | 10.0 | 3/3 | 1/1 | none |

## Scale (MA14)

- ask to card (preparation, stub world): 10.8 s; yes turn with sends: 5.1 s
- card messages: 9, longest 3752 characters
- approved 25, reached the employer 20, distinct postings sent 20
