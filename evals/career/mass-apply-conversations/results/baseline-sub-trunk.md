# Mass-apply conversations: baseline-sub-trunk

Commit 22bf37a1c4fee9b12ce10a37b279533e70942ceb · model subscription · 559 s · mean 5.47/10

| Scenario | Score | MUST | NICE | Failed checks |
|---|---|---|---|---|
| MA01 One message: every SWE internship in Chicago or remote I qualify for | 2.5 | 3/12 | 1/6 | **acts-turn1**, **wanted-includes**, left-out-named, **card-before-yes**, **hash-bound**, **enqueued-once**, **resume-attached**, **count-read-back**, **card-role-employer**, **card-link**, card-pay-deadline, card-fit, card-resume-file, proof-after |
| MA02 "apply to 50 data roles" when fewer exist | 1.5 | 2/13 | 1/6 | **acts-turn1**, **no-padding**, **min-found**, **real-count**, **card-before-yes**, **hash-bound**, **enqueued-once**, **resume-attached**, **count-read-back**, **card-role-employer**, **card-link**, card-pay-deadline, card-fit, card-resume-file, proof-after, offers-more |
| MA03 A vague ask | 8.0 | 4/4 | 0/1 | proposes-batch |
| MA04 Constraints: remote only, exclude a company | 2.0 | 3/15 | 2/6 | **acts-turn1**, **remote-only**, **includes-all**, **card-before-yes**, **hash-bound**, **enqueued-once**, **resume-attached**, **count-read-back**, **card-role-employer**, **card-link**, card-pay-deadline, card-fit, card-resume-file, proof-after, **approved-exact**, **approved-employers** |
| MA05 A batch with questions only the person can answer | 8.6 | 12/14 | 3/6 | **no-known-facts-asked**, one-round, **card-role-employer**, card-fit, proof-after |
| MA06 Partial yes: "yes except 2 and 5" | 1.7 | 1/6 | 0/1 | **card-of-5**, **subset-exact**, **hash-bound**, **enqueued-once**, **count-read-back**, left-out-named |
| MA07 "maybe" and a wrong count approve nothing | 3.3 | 2/6 | 0/0 | **wrong-count-explained**, **then-yes**, **hash-bound**, **enqueued-once** |
| MA08 Status check mid-run | 9.3 | 13/14 | 5/6 | **card-role-employer**, card-fit |
| MA09 A Workday link that needs the person's sign-in | 9.3 | 13/14 | 4/6 | **card-role-employer**, card-fit, proof-after |
| MA10 Duplicates: already applied, and one posting by two links | 10.0 | 5/5 | 0/0 | none |
| MA11 Follow-up: "apply to 20 more" | 2.0 | 1/5 | 1/1 | **acts-followup**, **no-resend**, **more-added**, **hash-bound** |
| MA12 Proof and receipts | 7.5 | 3/4 | 0/1 | **receipt-answers**, receipt-resume |
| MA13 No resume yet | 5.0 | 1/2 | 0/1 | **asks-resume**, keeps-ask |
| MA14 SCALE: 122 open postings in one ask | 1.3 | 1/8 | 1/2 | **queues-all**, **all-prepared**, **approved-all**, **enqueued-once**, **hash-bound**, **card-messages-fit**, chat-fit-summary, **count-read-back** |
| MA15 LinkedIn link: refused plainly | 10.0 | 3/3 | 1/1 | none |

## Scale (MA14)

- ask to card (preparation, stub world): 0.3 s; yes turn with sends: 0.6 s
- card messages: 0, longest 0 characters
- approved 0, reached the employer 0, distinct postings sent 0
