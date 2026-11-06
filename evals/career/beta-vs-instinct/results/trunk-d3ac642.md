# Beta vs Instinct scorecard: trunk-d3ac642

SHA `10eeabc36e92bc1c41af3e6708126ef6856bd665` · 2026-11-05T22:49:42.575Z · judge OFF (semantic criteria scored by deterministic proxies, score.ts proxy) · 5949s

> Semantic criteria are scored by deterministic proxies (score.ts proxy) unless --judge. Trainee's staged-brain turns carry scripted text: brain reply quality is NOT measured (routing, deliverable coverage and code-checked guards only). Live-model reply quality is S3's job in the deploy workflow. C01's exact live text is not in the report; its input is reconstructed. Instinct verdicts are the report's descriptions of prepared control outputs, not an independent observation.

## Overall (primary metric: task completion, strict)

Task completion = prompts whose every requested deliverable was verifiably produced, over all prompts. Unverified = the scripted brain answered, so the content cannot be measured here; it counts as not complete.

| state | prompts | TASK COMPLETION (strict) | delivered | failed a deliverable | unverified (scripted brain) | guards held | criteria met (measured) | criteria unmeasured |
|---|---|---|---|---|---|---|---|---|
| empty | 104 | **22.1%** | 23 | 17 | 64 | 104/104 | 182/215 (84.7%) | 133 |
| seeded | 104 | **18.3%** | 19 | 23 | 62 | 104/104 | 184/223 (82.5%) | 129 |

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
| A2 Approval binding | 1/0/3 · 6/6 | 1/0/3 · 6/6 |
| A3 Cloud apply | 2/0/2 · 8/8 | 1/2/1 · 8/10 |
| A4 Extension (excluded) | 0/1/3 · 5/7 | 0/1/3 · 5/7 |
| A5 Answer bank | 2/0/2 · 9/9 | 2/0/2 · 9/9 |
| A6 Resume tailoring | 1/2/1 · 9/12 | 1/2/1 · 10/13 |
| A7 Written answers | 0/0/4 · 4/4 | 0/0/4 · 4/4 |
| A8 Ingestion freshness | 1/0/3 · 5/5 | 0/1/3 · 5/6 |
| A9 Search | 2/1/1 · 9/11 | 2/1/1 · 10/12 |
| A10 Alerts | 0/1/3 · 7/8 | 0/1/3 · 7/8 |
| A11 Networking | 1/0/3 · 6/6 | 1/0/3 · 6/6 |
| A12 Outreach | 0/2/2 · 6/8 | 0/2/2 · 6/8 |
| A13 Warm intros | 0/0/4 · 5/5 | 0/0/4 · 5/5 |
| A14 Tracking | 3/0/1 · 9/9 | 3/0/1 · 10/10 |
| A15 Interview prep | 1/3/0 · 9/15 | 1/3/0 · 9/15 |
| A16 Offers and guidance | 1/0/3 · 6/6 | 1/0/3 · 6/6 |
| A17 Chat and guards | 1/0/3 · 6/6 | 1/0/3 · 6/6 |
| A18 Memory | 1/0/3 · 9/9 | 0/1/3 · 8/9 |
| A19 Onboarding | 1/0/3 · 6/6 | 1/0/3 · 6/6 |
| A20 Channels | 0/1/3 · 5/8 | 0/1/3 · 5/8 |
| A21 Digest | 0/1/3 · 7/8 | 0/1/3 · 7/8 |
| A22 Privacy | 1/0/3 · 8/8 | 1/0/3 · 8/8 |
| A23 Portal codes | 0/0/4 · 4/4 | 0/1/3 · 5/6 |
| A24 Apply by email | 0/0/4 · 4/4 | 0/0/4 · 4/4 |
| A25 Measurement | 1/0/3 · 6/6 | 1/0/3 · 6/6 |

## Records

| case | state | layer | intent | delivered | guards | failed criteria | buckets | router ms | cpu ms |
|---|---|---|---|---|---|---|---|---|---|
| C01 | empty | router | career_discovery | false | held | links3: roles=0; relevant: proxy: 1/3 of /(customer support/customer service/support specialist/suppor/; honest_links: proxy: 0/3 of /https?://\S+/ | search_query_polluted_by_count_or_constraint_words | 2392 | 746 |
| C02 | empty | router | company_intel | false | held | roles: proxy: 0/3 of /patient access/patient services/medical (receptionist/assist/; training: proxy: 0/1 of /certificat\w*/certified/course\w*/CMAA/CPhT/\bCPC\b/CHAA/CRC/ | template_beats_requested_deliverable | 264 | 200 |
| C03 | empty | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 198 | 245 |
| C04 | empty | router | negotiation_draft | false | held | answers: proxy: 0/1 of /\b(yes/yes,/i would/i'd/worth (a )?counter\w*/don't counter//; asks_more: proxy: 0/1 of /\$\s?(2[5-9]/[3-9]\d)(\.\d\d)?\b/benefit/schedule/package/\b/; no_placeholder: proxy: matched "t", "h", "e" | template_beats_requested_deliverable | 126 | 112 |
| A1.1 | empty | router | career_discovery | false | held | ten: roles=0; relevant: proxy: 1/10 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 421 | 200 |
| A1.2 | empty | code_first | career_apply_queue | true | held |  |  | 0 | 63 |
| A1.3 | empty | router | career_list_reference | true | held |  |  | 208 | 141 |
| A1.4 | empty | router | career_batch_apply | true | held |  |  | 8 | 83 |
| A2.1 | empty | staged_brain | agent | unverified | held |  |  | 9 | 121 |
| A2.2 | empty | staged_brain | agent | unverified | held |  |  | 7 | 86 |
| A2.3 | empty | staged_brain | agent | unverified | held |  |  | 20 | 84 |
| A2.4 | empty | router | career_approval_rule | true | held |  |  | 101 | 103 |
| A3.1 | empty | router | career_tailor | true | held |  |  | 213 | 106 |
| A3.2 | empty | router | captcha_handoff | true | held |  |  | 3 | 66 |
| A3.3 | empty | staged_brain | agent | unverified | held |  |  | 5 | 89 |
| A3.4 | empty | staged_brain | agent | unverified | held |  |  | 8 | 53 |
| A4.1 | empty | staged_brain | agent | unverified | held |  |  | 4 | 47 |
| A4.2 | empty | router | connect_browser_source | false | held | not_connect: intent connect_browser_source; direct: proxy: 0/1 of /\bcloud\b/without (an /the )?extension/no extension/; must not say "LinkedIn" | greedy_keyword_matcher | 4 | 75 |
| A4.3 | empty | staged_brain | agent | unverified | held |  |  | 5 | 45 |
| A4.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 46 |
| A5.1 | empty | router | career_application_fields | true | held |  |  | 105 | 96 |
| A5.2 | empty | staged_brain | agent | unverified | held |  |  | 16 | 90 |
| A5.3 | empty | staged_brain | agent | unverified | held |  |  | 7 | 85 |
| A5.4 | empty | router | intent_sensitive_correction | true | held |  |  | 60 | 80 |
| A6.1 | empty | router | career_tailor | false | held | empty: does not say the record is missing | template_beats_requested_deliverable | 208 | 103 |
| A6.2 | empty | router | intent_refusal | false | held | on_topic: must not match /outreach/shortlist/verified emails/; ack: proxy: 0/1 of /\bSQL\b[^.]{0,80}\b(won't/will not/not/never/only)\b/\b(won'/ | negation_read_as_intent | 32 | 83 |
| A6.3 | empty | staged_brain | agent | unverified | held |  |  | 5 | 56 |
| A6.4 | empty | router | career_document_delivery | true | held |  |  | 85 | 83 |
| A7.1 | empty | staged_brain | agent | unverified | held |  |  | 8 | 62 |
| A7.2 | empty | staged_brain | agent | unverified | held |  |  | 257 | 80 |
| A7.3 | empty | staged_brain | agent | unverified | held |  |  | 21 | 72 |
| A7.4 | empty | staged_brain | agent | unverified | held |  |  | 18 | 90 |
| A8.1 | empty | staged_brain | agent | unverified | held |  |  | 8 | 71 |
| A8.2 | empty | staged_brain | agent | unverified | held |  |  | 23 | 59 |
| A8.3 | empty | staged_brain | agent | unverified | held |  |  | 5 | 107 |
| A8.4 | empty | router | career_discovery | true | held |  |  | 441 | 179 |
| A9.1 | empty | router | career_discovery | false | held | three: roles=0; relevant: proxy: 0/3 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 493 | 158 |
| A9.2 | empty | router | career_discovery | true | held |  |  | 131 | 136 |
| A9.3 | empty | staged_brain | agent | unverified | held |  |  | 8 | 120 |
| A9.4 | empty | router | career_discovery | true | held |  |  | 377 | 160 |
| A10.1 | empty | staged_brain | agent | unverified | held |  |  | 9 | 68 |
| A10.2 | empty | staged_brain | agent | unverified | held |  |  | 7 | 120 |
| A10.3 | empty | router | career_watch_manage | false | held | explains: proxy: 0/1 of /\bpause\b[^.]{0,80}\b(say/send/text/type/reply)\b/\b(say/sen/ | template_beats_requested_deliverable | 72 | 152 |
| A10.4 | empty | staged_brain | agent | unverified | held |  |  | 7 | 59 |
| A11.1 | empty | code_first | career_people_alumni | true | held |  |  | 0 | 55 |
| A11.2 | empty | staged_brain | agent | unverified | held |  |  | 40 | 109 |
| A11.3 | empty | staged_brain | agent | unverified | held |  |  | 6 | 38 |
| A11.4 | empty | staged_brain | agent | unverified | held |  |  | 6 | 44 |
| A12.1 | empty | code_first | career_networking_draft | false | held | draft: proxy: 0/1 of /subject:/\n\s*(hi/hello/dear)\b/\bwho\b[^.?]{0,60}\?/which (/ | template_beats_requested_deliverable | 0 | 40 |
| A12.2 | empty | staged_brain | agent | unverified | held |  |  | 6 | 49 |
| A12.3 | empty | code_first | career_networking_draft | false | held | ack: proxy: 0/1 of /\b(no/nothing/won't/will not/never)\b[^.]{0,50}\b(email/send/ | template_beats_requested_deliverable | 0 | 52 |
| A12.4 | empty | staged_brain | agent | unverified | held |  |  | 7 | 57 |
| A13.1 | empty | staged_brain | agent | unverified | held |  |  | 23 | 202 |
| A13.2 | empty | staged_brain | agent | unverified | held |  |  | 9 | 69 |
| A13.3 | empty | staged_brain | agent | unverified | held |  |  | 10 | 127 |
| A13.4 | empty | staged_brain | agent | unverified | held |  |  | 7 | 61 |
| A14.1 | empty | router | tracking_status | true | held |  |  | 94 | 179 |
| A14.2 | empty | code_first | career_apply_status | true | held |  |  | 0 | 38 |
| A14.3 | empty | code_first | career_activity | true | held |  |  | 0 | 67 |
| A14.4 | empty | staged_brain | agent | unverified | held |  |  | 3 | 53 |
| A15.1 | empty | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 142 | 81 |
| A15.2 | empty | router | prep_brief | false | held | no_invent: proxy: matched "question", "tomorrow", "interview"; must not say "scored input" | template_beats_requested_deliverable | 62 | 213 |
| A15.3 | empty | router | honest_unavailable | true | held |  |  | 80 | 70 |
| A15.4 | empty | router | prep_brief | false | held | one_q: questions=0; support: proxy: 0/1 of /customer/caller/ticket/upset/angry/complain\w*/escalat\w*/; must not say "Tell me about yourself" | template_beats_requested_deliverable | 25 | 173 |
| A16.1 | empty | router | path_plan | true | held |  |  | 106 | 118 |
| A16.2 | empty | staged_brain | agent | unverified | held |  |  | 336 | 87 |
| A16.3 | empty | staged_brain | agent | unverified | held |  |  | 10 | 45 |
| A16.4 | empty | staged_brain | agent | unverified | held |  |  | 3 | 36 |
| A17.1 | empty | staged_brain | agent | unverified | held |  |  | 5 | 54 |
| A17.2 | empty | staged_brain | agent | unverified | held |  |  | 13 | 66 |
| A17.3 | empty | staged_brain | agent | unverified | held |  |  | 20 | 70 |
| A17.4 | empty | code_first | conversation_redo | true | held |  |  | 0 | 40 |
| A18.1 | empty | router | conversation_recall | true | held |  |  | 43 | 103 |
| A18.2 | empty | staged_brain | agent | unverified | held |  |  | 53 | 76 |
| A18.3 | empty | staged_brain | agent | unverified | held |  |  | 13 | 70 |
| A18.4 | empty | staged_brain | agent | unverified | held |  |  | 82 | 58 |
| A19.1 | empty | router | career_onboarding_needs | true | held |  |  | 80 | 106 |
| A19.2 | empty | staged_brain | agent | unverified | held |  |  | 30 | 72 |
| A19.3 | empty | staged_brain | agent | unverified | held |  |  | 10 | 61 |
| A19.4 | empty | staged_brain | agent | unverified | held |  |  | 11 | 65 |
| A20.1 | empty | staged_brain | agent | unverified | held |  |  | 29 | 91 |
| A20.2 | empty | router | company_intel | false | held | not_intel: intent company_intel; on_topic: must not match /company file/company-file/; direct: proxy: 0/1 of /\b(yes/same (search/account/thread)/continue\w*/carries over/; must not say "company file" | greedy_keyword_matcher | 153 | 118 |
| A20.3 | empty | staged_brain | agent | unverified | held |  |  | 9 | 77 |
| A20.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 53 |
| A21.1 | empty | router | tracking_digest | false | held | explains: proxy: matched "digest: nothing has moved yet "; must not say "nothing has moved yet" | template_beats_requested_deliverable | 96 | 95 |
| A21.2 | empty | staged_brain | agent | unverified | held |  |  | 25 | 67 |
| A21.3 | empty | staged_brain | agent | unverified | held |  |  | 4 | 57 |
| A21.4 | empty | staged_brain | agent | unverified | held |  |  | 8 | 40 |
| A22.1 | empty | staged_brain | agent | unverified | held |  |  | 39 | 58 |
| A22.2 | empty | staged_brain | agent | unverified | held |  |  | 38 | 59 |
| A22.3 | empty | staged_brain | agent | unverified | held |  |  | 9 | 66 |
| A22.4 | empty | router | career_erase_confirm | true | held |  |  | 65 | 82 |
| A23.1 | empty | staged_brain | agent | unverified | held |  |  | 158 | 102 |
| A23.2 | empty | staged_brain | agent | unverified | held |  |  | 46 | 63 |
| A23.3 | empty | staged_brain | agent | unverified | held |  |  | 7 | 61 |
| A23.4 | empty | staged_brain | agent | unverified | held |  |  | 3 | 43 |
| A24.1 | empty | staged_brain | agent | unverified | held |  |  | 10 | 79 |
| A24.2 | empty | staged_brain | agent | unverified | held |  |  | 18 | 66 |
| A24.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 42 |
| A24.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 41 |
| A25.1 | empty | code_first | career_activity | true | held |  |  | 0 | 35 |
| A25.2 | empty | staged_brain | agent | unverified | held |  |  | 10 | 71 |
| A25.3 | empty | staged_brain | agent | unverified | held |  |  | 19 | 57 |
| A25.4 | empty | staged_brain | agent | unverified | held |  |  | 31 | 70 |
| C01 | seeded | router | career_discovery | false | held | links3: roles=0; relevant: proxy: 1/3 of /(customer support/customer service/support specialist/suppor/; honest_links: proxy: 0/3 of /https?://\S+/ | search_query_polluted_by_count_or_constraint_words | 1038 | 348 |
| C02 | seeded | router | company_intel | false | held | roles: proxy: 0/3 of /patient access/patient services/medical (receptionist/assist/; training: proxy: 0/1 of /certificat\w*/certified/course\w*/CMAA/CPhT/\bCPC\b/CHAA/CRC/ | template_beats_requested_deliverable | 1092 | 169 |
| C03 | seeded | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 325 | 124 |
| C04 | seeded | router | negotiation_draft | false | held | answers: proxy: 0/1 of /\b(yes/yes,/i would/i'd/worth (a )?counter\w*/don't counter//; asks_more: proxy: 0/1 of /\$\s?(2[5-9]/[3-9]\d)(\.\d\d)?\b/benefit/schedule/package/\b/; no_placeholder: proxy: matched "t", "h", "e" | template_beats_requested_deliverable | 123 | 100 |
| A1.1 | seeded | router | career_discovery | false | held | ten: roles=0; relevant: proxy: 1/10 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 959 | 267 |
| A1.2 | seeded | code_first | career_apply_queue | true | held |  |  | 0 | 117 |
| A1.3 | seeded | router | career_list_reference | false | held | binds: proxy: 0/1 of /skip\w*/remov\w*/dropp\w*/without/leaving/kept/rest of/ | missing_batch_executor_or_approval_binding, template_beats_requested_deliverable | 33 | 220 |
| A1.4 | seeded | router | career_batch_apply | true | held |  |  | 112 | 122 |
| A2.1 | seeded | staged_brain | agent | unverified | held |  |  | 9 | 77 |
| A2.2 | seeded | staged_brain | agent | unverified | held |  |  | 74 | 123 |
| A2.3 | seeded | staged_brain | agent | unverified | held |  |  | 36 | 86 |
| A2.4 | seeded | router | career_approval_rule | true | held |  |  | 405 | 119 |
| A3.1 | seeded | router | packet_needs_role | false | held | asks: proxy: matched "name the role"; must not say "backend" | template_beats_requested_deliverable | 3340 | 422 |
| A3.2 | seeded | router | captcha_handoff | true | held |  |  | 39 | 68 |
| A3.3 | seeded | router | portal_account | false | held | rule: proxy: 0/1 of /\b(you/yourself)\b[^.]{0,60}\b(sign in/sign up/create/log in/; must not say "alias" | template_beats_requested_deliverable | 446 | 128 |
| A3.4 | seeded | staged_brain | agent | unverified | held |  |  | 244 | 152 |
| A4.1 | seeded | staged_brain | agent | unverified | held |  |  | 17 | 74 |
| A4.2 | seeded | router | connect_browser_source | false | held | not_connect: intent connect_browser_source; direct: proxy: 0/1 of /\bcloud\b/without (an /the )?extension/no extension/; must not say "LinkedIn" | greedy_keyword_matcher | 29 | 70 |
| A4.3 | seeded | staged_brain | agent | unverified | held |  |  | 61 | 69 |
| A4.4 | seeded | staged_brain | agent | unverified | held |  |  | 258 | 98 |
| A5.1 | seeded | router | career_application_fields | true | held |  |  | 244 | 160 |
| A5.2 | seeded | staged_brain | agent | unverified | held |  |  | 177 | 85 |
| A5.3 | seeded | staged_brain | agent | unverified | held |  |  | 151 | 93 |
| A5.4 | seeded | router | intent_sensitive_correction | true | held |  |  | 134 | 127 |
| A6.1 | seeded | router | career_tailor | false | held | role_match: /customer (support/service)/ | template_beats_requested_deliverable | 1373 | 442 |
| A6.2 | seeded | router | intent_refusal | false | held | on_topic: must not match /outreach/shortlist/verified emails/; ack: proxy: 0/1 of /\bSQL\b[^.]{0,80}\b(won't/will not/not/never/only)\b/\b(won'/ | negation_read_as_intent | 424 | 127 |
| A6.3 | seeded | staged_brain | agent | unverified | held |  |  | 85 | 93 |
| A6.4 | seeded | router | career_document_delivery | true | held |  |  | 31 | 63 |
| A7.1 | seeded | staged_brain | agent | unverified | held |  |  | 74 | 74 |
| A7.2 | seeded | staged_brain | agent | unverified | held |  |  | 13 | 67 |
| A7.3 | seeded | staged_brain | agent | unverified | held |  |  | 8 | 74 |
| A7.4 | seeded | staged_brain | agent | unverified | held |  |  | 12 | 59 |
| A8.1 | seeded | staged_brain | agent | unverified | held |  |  | 79 | 101 |
| A8.2 | seeded | staged_brain | agent | unverified | held |  |  | 41 | 80 |
| A8.3 | seeded | staged_brain | agent | unverified | held |  |  | 79 | 81 |
| A8.4 | seeded | router | career_discovery | false | held | roles: roles=0 | search_query_polluted_by_count_or_constraint_words | 550 | 266 |
| A9.1 | seeded | router | career_discovery | false | held | three: roles=0; relevant: proxy: 0/3 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 637 | 288 |
| A9.2 | seeded | router | career_discovery | true | held |  |  | 493 | 267 |
| A9.3 | seeded | staged_brain | agent | unverified | held |  |  | 6 | 58 |
| A9.4 | seeded | router | career_discovery | true | held |  |  | 650 | 265 |
| A10.1 | seeded | staged_brain | agent | unverified | held |  |  | 9 | 54 |
| A10.2 | seeded | staged_brain | agent | unverified | held |  |  | 68 | 87 |
| A10.3 | seeded | router | career_watch_manage | false | held | explains: proxy: 0/1 of /\bpause\b[^.]{0,80}\b(say/send/text/type/reply)\b/\b(say/sen/ | template_beats_requested_deliverable | 514 | 145 |
| A10.4 | seeded | staged_brain | agent | unverified | held |  |  | 62 | 110 |
| A11.1 | seeded | code_first | career_people_alumni | true | held |  |  | 0 | 89 |
| A11.2 | seeded | staged_brain | agent | unverified | held |  |  | 231 | 106 |
| A11.3 | seeded | staged_brain | agent | unverified | held |  |  | 151 | 79 |
| A11.4 | seeded | staged_brain | agent | unverified | held |  |  | 610 | 142 |
| A12.1 | seeded | code_first | career_networking_draft | false | held | draft: proxy: 0/1 of /subject:/\n\s*(hi/hello/dear)\b/\bwho\b[^.?]{0,60}\?/which (/ | template_beats_requested_deliverable | 0 | 52 |
| A12.2 | seeded | staged_brain | agent | unverified | held |  |  | 356 | 92 |
| A12.3 | seeded | code_first | career_networking_draft | false | held | ack: proxy: 0/1 of /\b(no/nothing/won't/will not/never)\b[^.]{0,50}\b(email/send/ | template_beats_requested_deliverable | 0 | 43 |
| A12.4 | seeded | staged_brain | agent | unverified | held |  |  | 126 | 116 |
| A13.1 | seeded | staged_brain | agent | unverified | held |  |  | 23 | 60 |
| A13.2 | seeded | staged_brain | agent | unverified | held |  |  | 71 | 81 |
| A13.3 | seeded | staged_brain | agent | unverified | held |  |  | 36 | 67 |
| A13.4 | seeded | staged_brain | agent | unverified | held |  |  | 37 | 87 |
| A14.1 | seeded | router | tracking_status | true | held |  |  | 153 | 95 |
| A14.2 | seeded | code_first | career_apply_status | true | held |  |  | 0 | 69 |
| A14.3 | seeded | code_first | career_activity | true | held |  |  | 0 | 66 |
| A14.4 | seeded | staged_brain | agent | unverified | held |  |  | 117 | 80 |
| A15.1 | seeded | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 396 | 122 |
| A15.2 | seeded | router | prep_brief | false | held | no_invent: proxy: matched "question", "tomorrow", "interview"; must not say "scored input" | template_beats_requested_deliverable | 196 | 284 |
| A15.3 | seeded | router | honest_unavailable | true | held |  |  | 70 | 96 |
| A15.4 | seeded | router | prep_brief | false | held | one_q: questions=0; support: proxy: 0/1 of /customer/caller/ticket/upset/angry/complain\w*/escalat\w*/; must not say "Tell me about yourself" | template_beats_requested_deliverable | 344 | 130 |
| A16.1 | seeded | router | path_plan | true | held |  |  | 139 | 112 |
| A16.2 | seeded | staged_brain | agent | unverified | held |  |  | 465 | 131 |
| A16.3 | seeded | staged_brain | agent | unverified | held |  |  | 37 | 69 |
| A16.4 | seeded | staged_brain | agent | unverified | held |  |  | 27 | 61 |
| A17.1 | seeded | staged_brain | agent | unverified | held |  |  | 117 | 87 |
| A17.2 | seeded | staged_brain | agent | unverified | held |  |  | 191 | 155 |
| A17.3 | seeded | staged_brain | agent | unverified | held |  |  | 36 | 75 |
| A17.4 | seeded | code_first | conversation_redo | true | held |  |  | 0 | 50 |
| A18.1 | seeded | router | conversation_recall | false | held | recall: proxy: 0/1 of /customer support/Chicago/ | template_beats_requested_deliverable | 157 | 96 |
| A18.2 | seeded | staged_brain | agent | unverified | held |  |  | 113 | 96 |
| A18.3 | seeded | staged_brain | agent | unverified | held |  |  | 49 | 77 |
| A18.4 | seeded | staged_brain | agent | unverified | held |  |  | 100 | 78 |
| A19.1 | seeded | router | career_onboarding_needs | true | held |  |  | 116 | 98 |
| A19.2 | seeded | staged_brain | agent | unverified | held |  |  | 14 | 77 |
| A19.3 | seeded | staged_brain | agent | unverified | held |  |  | 56 | 76 |
| A19.4 | seeded | staged_brain | agent | unverified | held |  |  | 13 | 373 |
| A20.1 | seeded | staged_brain | agent | unverified | held |  |  | 10 | 350 |
| A20.2 | seeded | router | company_intel | false | held | not_intel: intent company_intel; on_topic: must not match /company file/company-file/; direct: proxy: 0/1 of /\b(yes/same (search/account/thread)/continue\w*/carries over/; must not say "company file" | greedy_keyword_matcher | 156 | 318 |
| A20.3 | seeded | staged_brain | agent | unverified | held |  |  | 23 | 242 |
| A20.4 | seeded | staged_brain | agent | unverified | held |  |  | 26 | 171 |
| A21.1 | seeded | router | tracking_digest | false | held | explains: proxy: matched "digest: nothing has moved yet "; must not say "nothing has moved yet" | template_beats_requested_deliverable | 195 | 325 |
| A21.2 | seeded | staged_brain | agent | unverified | held |  |  | 140 | 115 |
| A21.3 | seeded | staged_brain | agent | unverified | held |  |  | 125 | 90 |
| A21.4 | seeded | staged_brain | agent | unverified | held |  |  | 184 | 265 |
| A22.1 | seeded | staged_brain | agent | unverified | held |  |  | 58 | 75 |
| A22.2 | seeded | staged_brain | agent | unverified | held |  |  | 70 | 79 |
| A22.3 | seeded | staged_brain | agent | unverified | held |  |  | 54 | 271 |
| A22.4 | seeded | router | career_erase_confirm | true | held |  |  | 97 | 273 |
| A23.1 | seeded | staged_brain | agent | unverified | held |  |  | 244 | 94 |
| A23.2 | seeded | staged_brain | agent | unverified | held |  |  | 42 | 70 |
| A23.3 | seeded | staged_brain | agent | unverified | held |  |  | 130 | 274 |
| A23.4 | seeded | router | portal_account | false | held | rule: proxy: 0/1 of /\b(won't/will not/never/can't/cannot/don't)\b[^.]{0,60}passw/; must not say "alias" | template_beats_requested_deliverable | 266 | 95 |
| A24.1 | seeded | staged_brain | agent | unverified | held |  |  | 56 | 73 |
| A24.2 | seeded | staged_brain | agent | unverified | held |  |  | 66 | 60 |
| A24.3 | seeded | staged_brain | agent | unverified | held |  |  | 52 | 68 |
| A24.4 | seeded | staged_brain | agent | unverified | held |  |  | 157 | 270 |
| A25.1 | seeded | code_first | career_activity | true | held |  |  | 0 | 57 |
| A25.2 | seeded | staged_brain | agent | unverified | held |  |  | 14 | 77 |
| A25.3 | seeded | staged_brain | agent | unverified | held |  |  | 72 | 75 |
| A25.4 | seeded | staged_brain | agent | unverified | held |  |  | 22 | 65 |
