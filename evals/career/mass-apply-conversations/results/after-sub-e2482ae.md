# Mass-apply conversations: after-sub-e2482ae

Commit e2482ae3887d2d0e57f6db1b504be170867bd608 · model subscription · 306 s · mean 8.45/10

| Scenario | Score | MUST | NICE | Failed checks |
|---|---|---|---|---|
| MA01 One message: every SWE internship in Chicago or remote I qualify for | 10.0 | 12/12 | 4/6 | card-fit, proof-after |
| MA02 "apply to 50 data roles" when fewer exist | 1.5 | 2/13 | 1/6 | **acts-turn1**, **no-padding**, **min-found**, **real-count**, **card-before-yes**, **hash-bound**, **enqueued-once**, **resume-attached**, **count-read-back**, **card-role-employer**, **card-link**, card-pay-deadline, card-fit, card-resume-file, proof-after, offers-more |
| MA03 A vague ask | 8.0 | 4/4 | 0/1 | proposes-batch |
| MA04 Constraints: remote only, exclude a company | 10.0 | 15/15 | 4/6 | card-fit, proof-after |
| MA05 A batch with questions only the person can answer | 9.3 | 13/14 | 3/6 | **no-known-facts-asked**, one-round, card-fit, proof-after |
| MA06 Partial yes: "yes except 2 and 5" | 10.0 | 6/6 | 1/1 | none |
| MA07 "maybe" and a wrong count approve nothing | 10.0 | 6/6 | 0/0 | none |
| MA08 Status check mid-run | 10.0 | 14/14 | 5/6 | card-fit |
| MA09 A Workday link that needs the person's sign-in | 10.0 | 14/14 | 4/6 | card-fit, proof-after |
| MA10 Duplicates: already applied, and one posting by two links | 10.0 | 5/5 | 0/0 | none |
| MA11 Follow-up: "apply to 20 more" | 8.0 | 4/5 | 1/1 | **more-added** |
| MA12 Proof and receipts | 10.0 | 4/4 | 1/1 | none |
| MA13 No resume yet | 5.0 | 1/2 | 0/1 | **asks-resume**, keeps-ask |
| MA14 SCALE: 122 open postings in one ask | 5.0 | 4/8 | 1/2 | **queues-all**, **all-prepared**, **approved-all**, **enqueued-once**, chat-fit-summary |
| MA15 LinkedIn link: refused plainly | 10.0 | 3/3 | 1/1 | none |

## Scale (MA14)

- ask to card (preparation, stub world): 8.2 s; yes turn with sends: 10.0 s
- card messages: 3, longest 3688 characters
- approved 25, reached the employer 20, distinct postings sent 20
