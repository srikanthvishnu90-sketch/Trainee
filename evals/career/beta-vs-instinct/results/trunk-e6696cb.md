# Beta vs Instinct scorecard: trunk-e6696cb

SHA `e6696cb17cd241136d6a2b2cfc24494280e77816` · 2026-11-05T05:11:00.064Z · judge OFF (semantic criteria scored by deterministic proxies, score.ts proxy) · 101s

> Semantic criteria are scored by deterministic proxies (score.ts proxy) unless --judge. Trainee's staged-brain turns carry scripted text: brain reply quality is NOT measured (routing, deliverable coverage and code-checked guards only). Live-model reply quality is S3's job in the deploy workflow. C01's exact live text is not in the report; its input is reconstructed. Instinct verdicts are the report's descriptions of prepared control outputs, not an independent observation.

## Overall (primary metric: task completion, strict)

Task completion = prompts whose every requested deliverable was verifiably produced, over all prompts. Unverified = the scripted brain answered, so the content cannot be measured here; it counts as not complete.

| state | prompts | TASK COMPLETION (strict) | delivered | failed a deliverable | unverified (scripted brain) | guards held | criteria met (measured) | criteria unmeasured |
|---|---|---|---|---|---|---|---|---|
| empty | 104 | **24%** | 25 | 17 | 62 | 104/104 | 250/283 (88.3%) | 65 |
| seeded | 104 | **20.2%** | 21 | 23 | 60 | 104/104 | 250/289 (86.5%) | 63 |

## Which layer decided

| layer | empty | seeded |
|---|---|---|
| router | 32 | 34 |
| code_first | 8 | 8 |
| staged_brain | 64 | 62 |

## Root-cause buckets (failed records; one record can be in several)

| bucket | empty | seeded |
|---|---|---|
| template_beats_requested_deliverable | 11 | 16 |
| search_query_polluted_by_count_or_constraint_words | 3 | 4 |
| missing_artifact_path | 2 | 2 |
| greedy_keyword_matcher | 2 | 2 |
| negation_read_as_intent | 1 | 1 |
| missing_batch_executor_or_approval_binding | 0 | 1 |

## Trainee vs Instinct (C01-C04; Instinct = the report's prepared control outputs)

| case | Instinct criteria met | Trainee empty | Trainee seeded |
|---|---|---|---|
| C01 Three realistic job links | 3/4 | 2/4 via router career_discovery | 2/4 via router career_discovery |
| C02 Retail to healthcare | 5/5 (pass) | 3/5 via router company_intel | 3/5 via router company_intel |
| C03 One-page interview prep File | 6/7 | 4/7 via router prep_brief | 4/7 via router prep_brief |
| C04 $24/hour counteroffer draft | 7/7 (pass) | 4/7 via router negotiation_draft | 4/7 via router negotiation_draft |

## Per feature

| feature | empty delivered/failed/unverified · criteria | seeded delivered/failed/unverified · criteria |
|---|---|---|
| C Live beta tasks (C01-C04) | 0/4/0 · 13/24 | 0/4/0 · 13/24 |
| A1 Mass apply | 3/1/0 · 11/13 | 2/2/0 · 10/13 |
| A2 Approval binding | 1/0/3 · 9/9 | 1/0/3 · 9/9 |
| A3 Cloud apply | 2/0/2 · 10/10 | 1/2/1 · 9/11 |
| A4 Extension (excluded) | 0/1/3 · 8/10 | 0/1/3 · 8/10 |
| A5 Answer bank | 2/0/2 · 12/12 | 2/0/2 · 12/12 |
| A6 Resume tailoring | 1/2/1 · 10/13 | 1/2/1 · 11/14 |
| A7 Written answers | 0/0/4 · 8/8 | 0/0/4 · 8/8 |
| A8 Ingestion freshness | 1/0/3 · 8/8 | 0/1/3 · 8/9 |
| A9 Search | 2/1/1 · 10/12 | 2/1/1 · 11/13 |
| A10 Alerts | 0/1/3 · 10/11 | 0/1/3 · 10/11 |
| A11 Networking | 1/0/3 · 10/10 | 1/0/3 · 10/10 |
| A12 Outreach | 0/2/2 · 8/10 | 0/2/2 · 8/10 |
| A13 Warm intros | 0/0/4 · 10/10 | 0/0/4 · 10/10 |
| A14 Tracking | 3/0/1 · 10/10 | 3/0/1 · 11/11 |
| A15 Interview prep | 1/3/0 · 9/15 | 1/3/0 · 9/15 |
| A16 Offers and guidance | 1/0/3 · 10/10 | 1/0/3 · 10/10 |
| A17 Chat and guards | 1/0/3 · 9/9 | 1/0/3 · 9/9 |
| A18 Memory | 3/0/1 · 12/12 | 2/1/1 · 11/12 |
| A19 Onboarding | 1/0/3 · 9/9 | 1/0/3 · 9/9 |
| A20 Channels | 0/1/3 · 8/11 | 0/1/3 · 8/11 |
| A21 Digest | 0/1/3 · 10/11 | 0/1/3 · 10/11 |
| A22 Privacy | 1/0/3 · 11/11 | 1/0/3 · 11/11 |
| A23 Portal codes | 0/0/4 · 8/8 | 0/1/3 · 8/9 |
| A24 Apply by email | 0/0/4 · 8/8 | 0/0/4 · 8/8 |
| A25 Measurement | 1/0/3 · 9/9 | 1/0/3 · 9/9 |

## Records

| case | state | layer | intent | delivered | guards | failed criteria | buckets | router ms | cpu ms |
|---|---|---|---|---|---|---|---|---|---|
| C01 | empty | router | career_discovery | false | held | links3: roles=0; relevant: proxy: 1/3 of /(customer support/customer service/support specialist/suppor/; honest_links: proxy: 0/3 of /https?://\S+/ | search_query_polluted_by_count_or_constraint_words | 546 | 790 |
| C02 | empty | router | company_intel | false | held | roles: proxy: 0/3 of /patient access/patient services/medical (receptionist/assist/; training: proxy: 0/1 of /certificat\w*/certified/course\w*/CMAA/CPhT/\bCPC\b/CHAA/CRC/ | template_beats_requested_deliverable | 284 | 354 |
| C03 | empty | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 262 | 355 |
| C04 | empty | router | negotiation_draft | false | held | answers: proxy: 0/1 of /\b(yes/yes,/i would/i'd/worth (a )?counter\w*/don't counter//; asks_more: proxy: 0/1 of /\$\s?(2[5-9]/[3-9]\d)(\.\d\d)?\b/benefit/schedule/package/\b/; no_placeholder: proxy: matched "t", "h", "e" | template_beats_requested_deliverable | 166 | 198 |
| A1.1 | empty | router | career_discovery | false | held | ten: roles=0; relevant: proxy: 1/10 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 224 | 286 |
| A1.2 | empty | code_first | career_apply_queue | true | held |  |  | 0 | 29 |
| A1.3 | empty | router | career_list_reference | true | held |  |  | 122 | 164 |
| A1.4 | empty | router | career_batch_apply | true | held |  |  | 2 | 31 |
| A2.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 56 |
| A2.2 | empty | staged_brain | agent | unverified | held |  |  | 5 | 36 |
| A2.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 73 |
| A2.4 | empty | router | career_approval_rule | true | held |  |  | 98 | 133 |
| A3.1 | empty | router | career_tailor | true | held |  |  | 177 | 203 |
| A3.2 | empty | router | captcha_handoff | true | held |  |  | 1 | 28 |
| A3.3 | empty | staged_brain | agent | unverified | held |  |  | 1 | 30 |
| A3.4 | empty | staged_brain | agent | unverified | held |  |  | 5 | 28 |
| A4.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 22 |
| A4.2 | empty | router | connect_browser_source | false | held | not_connect: intent connect_browser_source; direct: proxy: 0/1 of /\bcloud\b/without (an /the )?extension/no extension/; must not say "LinkedIn" | greedy_keyword_matcher | 0 | 23 |
| A4.3 | empty | staged_brain | agent | unverified | held |  |  | 1 | 30 |
| A4.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 26 |
| A5.1 | empty | router | career_application_fields | true | held |  |  | 301 | 336 |
| A5.2 | empty | staged_brain | agent | unverified | held |  |  | 6 | 46 |
| A5.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 29 |
| A5.4 | empty | router | intent_sensitive_correction | true | held |  |  | 5 | 36 |
| A6.1 | empty | router | career_tailor | false | held | empty: does not say the record is missing | template_beats_requested_deliverable | 469 | 290 |
| A6.2 | empty | router | intent_refusal | false | held | on_topic: must not match /outreach/shortlist/verified emails/; ack: proxy: 0/1 of /\bSQL\b[^.]{0,80}\b(won't/will not/not/never/only)\b/\b(won'/ | negation_read_as_intent | 234 | 178 |
| A6.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 34 |
| A6.4 | empty | router | career_document_delivery | true | held |  |  | 138 | 161 |
| A7.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 35 |
| A7.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 30 |
| A7.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 34 |
| A7.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 40 |
| A8.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 73 |
| A8.2 | empty | staged_brain | agent | unverified | held |  |  | 3 | 31 |
| A8.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 33 |
| A8.4 | empty | router | career_discovery | true | held |  |  | 372 | 410 |
| A9.1 | empty | router | career_discovery | false | held | three: roles=0; relevant: proxy: 0/3 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 440 | 396 |
| A9.2 | empty | router | career_discovery | true | held |  |  | 308 | 327 |
| A9.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 28 |
| A9.4 | empty | router | career_discovery | true | held |  |  | 406 | 369 |
| A10.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 33 |
| A10.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 23 |
| A10.3 | empty | router | career_watch_manage | false | held | explains: proxy: 0/1 of /\bpause\b[^.]{0,80}\b(say/send/text/type/reply)\b/\b(say/sen/ | template_beats_requested_deliverable | 123 | 141 |
| A10.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 30 |
| A11.1 | empty | code_first | career_people_alumni | true | held |  |  | 0 | 21 |
| A11.2 | empty | staged_brain | agent | unverified | held |  |  | 16 | 35 |
| A11.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 27 |
| A11.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 27 |
| A12.1 | empty | code_first | career_networking_draft | false | held | draft: proxy: 0/1 of /subject:/\n\s*(hi/hello/dear)\b/\bwho\b[^.?]{0,60}\?/which (/ | template_beats_requested_deliverable | 0 | 30 |
| A12.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 28 |
| A12.3 | empty | code_first | career_networking_draft | false | held | ack: proxy: 0/1 of /\b(no/nothing/won't/will not/never)\b[^.]{0,50}\b(email/send/ | template_beats_requested_deliverable | 0 | 25 |
| A12.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 41 |
| A13.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 24 |
| A13.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 28 |
| A13.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 26 |
| A13.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 31 |
| A14.1 | empty | router | tracking_status | true | held |  |  | 299 | 334 |
| A14.2 | empty | code_first | career_apply_status | true | held |  |  | 0 | 21 |
| A14.3 | empty | code_first | career_activity | true | held |  |  | 0 | 22 |
| A14.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 25 |
| A15.1 | empty | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 298 | 327 |
| A15.2 | empty | router | prep_brief | false | held | no_invent: proxy: matched "question", "tomorrow", "interview"; must not say "scored input" | template_beats_requested_deliverable | 250 | 274 |
| A15.3 | empty | router | honest_unavailable | true | held |  |  | 83 | 108 |
| A15.4 | empty | router | prep_brief | false | held | one_q: questions=0; support: proxy: 0/1 of /customer/caller/ticket/upset/angry/complain\w*/escalat\w*/; must not say "Tell me about yourself" | template_beats_requested_deliverable | 179 | 213 |
| A16.1 | empty | router | path_plan | true | held |  |  | 159 | 182 |
| A16.2 | empty | staged_brain | agent | unverified | held |  |  | 5 | 21 |
| A16.3 | empty | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A16.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 19 |
| A17.1 | empty | staged_brain | agent | unverified | held |  |  | 1 | 24 |
| A17.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 15 |
| A17.3 | empty | staged_brain | agent | unverified | held |  |  | 1 | 25 |
| A17.4 | empty | code_first | conversation_redo | true | held |  |  | 0 | 11 |
| A18.1 | empty | router | conversation_recall | true | held |  |  | 202 | 220 |
| A18.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 20 |
| A18.3 | empty | staged_brain | agent | true | held |  |  | 2 | 15 |
| A18.4 | empty | staged_brain | agent | true | held |  |  | 2 | 21 |
| A19.1 | empty | router | career_onboarding_needs | true | held |  |  | 220 | 241 |
| A19.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 16 |
| A19.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 26 |
| A19.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 17 |
| A20.1 | empty | staged_brain | agent | unverified | held |  |  | 1 | 18 |
| A20.2 | empty | router | company_intel | false | held | not_intel: intent company_intel; on_topic: must not match /company file/company-file/; direct: proxy: 0/1 of /\b(yes/same (search/account/thread)/continue\w*/carries over/; must not say "company file" | greedy_keyword_matcher | 246 | 273 |
| A20.3 | empty | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A20.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A21.1 | empty | router | tracking_digest | false | held | explains: proxy: matched "digest: nothing has moved yet "; must not say "nothing has moved yet" | template_beats_requested_deliverable | 85 | 112 |
| A21.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 18 |
| A21.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 18 |
| A21.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 17 |
| A22.1 | empty | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A22.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 19 |
| A22.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 21 |
| A22.4 | empty | router | career_erase_confirm | true | held |  |  | 78 | 103 |
| A23.1 | empty | staged_brain | agent | unverified | held |  |  | 1 | 27 |
| A23.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 18 |
| A23.3 | empty | staged_brain | agent | unverified | held |  |  | 1 | 15 |
| A23.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A24.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 19 |
| A24.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 22 |
| A24.3 | empty | staged_brain | agent | unverified | held |  |  | 1 | 17 |
| A24.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 15 |
| A25.1 | empty | code_first | career_activity | true | held |  |  | 0 | 14 |
| A25.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 24 |
| A25.3 | empty | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A25.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| C01 | seeded | router | career_discovery | false | held | links3: roles=0; relevant: proxy: 1/3 of /(customer support/customer service/support specialist/suppor/; honest_links: proxy: 0/3 of /https?://\S+/ | search_query_polluted_by_count_or_constraint_words | 548 | 553 |
| C02 | seeded | router | company_intel | false | held | roles: proxy: 0/3 of /patient access/patient services/medical (receptionist/assist/; training: proxy: 0/1 of /certificat\w*/certified/course\w*/CMAA/CPhT/\bCPC\b/CHAA/CRC/ | template_beats_requested_deliverable | 345 | 352 |
| C03 | seeded | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 323 | 342 |
| C04 | seeded | router | negotiation_draft | false | held | answers: proxy: 0/1 of /\b(yes/yes,/i would/i'd/worth (a )?counter\w*/don't counter//; asks_more: proxy: 0/1 of /\$\s?(2[5-9]/[3-9]\d)(\.\d\d)?\b/benefit/schedule/package/\b/; no_placeholder: proxy: matched "t", "h", "e" | template_beats_requested_deliverable | 280 | 268 |
| A1.1 | seeded | router | career_discovery | false | held | ten: roles=0; relevant: proxy: 1/10 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 398 | 403 |
| A1.2 | seeded | code_first | career_apply_queue | true | held |  |  | 0 | 51 |
| A1.3 | seeded | router | career_list_reference | false | held | binds: proxy: 0/1 of /skip\w*/remov\w*/dropp\w*/without/leaving/kept/rest of/ | missing_batch_executor_or_approval_binding, template_beats_requested_deliverable | 86 | 112 |
| A1.4 | seeded | router | career_batch_apply | true | held |  |  | 1 | 21 |
| A2.1 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 18 |
| A2.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 19 |
| A2.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 15 |
| A2.4 | seeded | router | career_approval_rule | true | held |  |  | 70 | 89 |
| A3.1 | seeded | router | packet_needs_role | false | held | asks: proxy: matched "name the role"; must not say "backend" | template_beats_requested_deliverable | 279 | 302 |
| A3.2 | seeded | router | captcha_handoff | true | held |  |  | 1 | 94 |
| A3.3 | seeded | router | portal_account | false | held | rule: proxy: 0/1 of /\b(you/yourself)\b[^.]{0,60}\b(sign in/sign up/create/log in/; must not say "alias" | template_beats_requested_deliverable | 200 | 221 |
| A3.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 31 |
| A4.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 30 |
| A4.2 | seeded | router | connect_browser_source | false | held | not_connect: intent connect_browser_source; direct: proxy: 0/1 of /\bcloud\b/without (an /the )?extension/no extension/; must not say "LinkedIn" | greedy_keyword_matcher | 0 | 35 |
| A4.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 17 |
| A4.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A5.1 | seeded | router | career_application_fields | true | held |  |  | 202 | 225 |
| A5.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 19 |
| A5.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 17 |
| A5.4 | seeded | router | intent_sensitive_correction | true | held |  |  | 3 | 21 |
| A6.1 | seeded | router | career_tailor | false | held | role_match: /customer (support/service)/ | template_beats_requested_deliverable | 382 | 470 |
| A6.2 | seeded | router | intent_refusal | false | held | on_topic: must not match /outreach/shortlist/verified emails/; ack: proxy: 0/1 of /\bSQL\b[^.]{0,80}\b(won't/will not/not/never/only)\b/\b(won'/ | negation_read_as_intent | 85 | 109 |
| A6.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 25 |
| A6.4 | seeded | router | career_document_delivery | true | held |  |  | 103 | 131 |
| A7.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 28 |
| A7.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 20 |
| A7.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 17 |
| A7.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 18 |
| A8.1 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A8.2 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A8.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 19 |
| A8.4 | seeded | router | career_discovery | false | held | roles: roles=0 | search_query_polluted_by_count_or_constraint_words | 215 | 240 |
| A9.1 | seeded | router | career_discovery | false | held | three: roles=0; relevant: proxy: 0/3 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 207 | 231 |
| A9.2 | seeded | router | career_discovery | true | held |  |  | 230 | 261 |
| A9.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 17 |
| A9.4 | seeded | router | career_discovery | true | held |  |  | 258 | 317 |
| A10.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 20 |
| A10.2 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 20 |
| A10.3 | seeded | router | career_watch_manage | false | held | explains: proxy: 0/1 of /\bpause\b[^.]{0,80}\b(say/send/text/type/reply)\b/\b(say/sen/ | template_beats_requested_deliverable | 78 | 101 |
| A10.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 19 |
| A11.1 | seeded | code_first | career_people_alumni | true | held |  |  | 0 | 22 |
| A11.2 | seeded | staged_brain | agent | unverified | held |  |  | 6 | 32 |
| A11.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 15 |
| A11.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A12.1 | seeded | code_first | career_networking_draft | false | held | draft: proxy: 0/1 of /subject:/\n\s*(hi/hello/dear)\b/\bwho\b[^.?]{0,60}\?/which (/ | template_beats_requested_deliverable | 0 | 13 |
| A12.2 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 15 |
| A12.3 | seeded | code_first | career_networking_draft | false | held | ack: proxy: 0/1 of /\b(no/nothing/won't/will not/never)\b[^.]{0,50}\b(email/send/ | template_beats_requested_deliverable | 0 | 11 |
| A12.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 18 |
| A13.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 18 |
| A13.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 19 |
| A13.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 23 |
| A13.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 32 |
| A14.1 | seeded | router | tracking_status | true | held |  |  | 314 | 323 |
| A14.2 | seeded | code_first | career_apply_status | true | held |  |  | 0 | 25 |
| A14.3 | seeded | code_first | career_activity | true | held |  |  | 0 | 15 |
| A14.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 24 |
| A15.1 | seeded | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 196 | 220 |
| A15.2 | seeded | router | prep_brief | false | held | no_invent: proxy: matched "question", "tomorrow", "interview"; must not say "scored input" | template_beats_requested_deliverable | 219 | 235 |
| A15.3 | seeded | router | honest_unavailable | true | held |  |  | 66 | 87 |
| A15.4 | seeded | router | prep_brief | false | held | one_q: questions=0; support: proxy: 0/1 of /customer/caller/ticket/upset/angry/complain\w*/escalat\w*/; must not say "Tell me about yourself" | template_beats_requested_deliverable | 135 | 157 |
| A16.1 | seeded | router | path_plan | true | held |  |  | 135 | 154 |
| A16.2 | seeded | staged_brain | agent | unverified | held |  |  | 4 | 17 |
| A16.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 153 |
| A16.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 18 |
| A17.1 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 18 |
| A17.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 21 |
| A17.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 28 |
| A17.4 | seeded | code_first | conversation_redo | true | held |  |  | 0 | 17 |
| A18.1 | seeded | router | conversation_recall | false | held | recall: proxy: 0/1 of /customer support/Chicago/ | template_beats_requested_deliverable | 287 | 315 |
| A18.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 16 |
| A18.3 | seeded | staged_brain | agent | true | held |  |  | 1 | 17 |
| A18.4 | seeded | staged_brain | agent | true | held |  |  | 1 | 17 |
| A19.1 | seeded | router | career_onboarding_needs | true | held |  |  | 199 | 223 |
| A19.2 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A19.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 14 |
| A19.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 15 |
| A20.1 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 18 |
| A20.2 | seeded | router | company_intel | false | held | not_intel: intent company_intel; on_topic: must not match /company file/company-file/; direct: proxy: 0/1 of /\b(yes/same (search/account/thread)/continue\w*/carries over/; must not say "company file" | greedy_keyword_matcher | 200 | 225 |
| A20.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 14 |
| A20.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 14 |
| A21.1 | seeded | router | tracking_digest | false | held | explains: proxy: matched "digest: nothing has moved yet "; must not say "nothing has moved yet" | template_beats_requested_deliverable | 79 | 98 |
| A21.2 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 21 |
| A21.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 22 |
| A21.4 | seeded | staged_brain | agent | unverified | held |  |  | 6 | 25 |
| A22.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 22 |
| A22.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 23 |
| A22.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 23 |
| A22.4 | seeded | router | career_erase_confirm | true | held |  |  | 68 | 90 |
| A23.1 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 15 |
| A23.2 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 15 |
| A23.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 16 |
| A23.4 | seeded | router | portal_account | false | held | rule: proxy: 0/1 of /\b(won't/will not/never/can't/cannot/don't)\b[^.]{0,60}passw/; must not say "alias" | template_beats_requested_deliverable | 135 | 157 |
| A24.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 16 |
| A24.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 18 |
| A24.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 17 |
| A24.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 17 |
| A25.1 | seeded | code_first | career_activity | true | held |  |  | 0 | 15 |
| A25.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 26 |
| A25.3 | seeded | staged_brain | agent | unverified | held |  |  | 5 | 40 |
| A25.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 22 |
