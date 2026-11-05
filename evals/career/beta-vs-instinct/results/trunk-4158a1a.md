# Beta vs Instinct scorecard: trunk-4158a1a

SHA `4158a1a38c488b9f277f44fd3059d4b7a6bf7999` · 2026-11-05T19:24:41.938Z · judge OFF (semantic criteria scored by deterministic proxies, score.ts proxy) · 117s

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
| C01 | empty | router | career_discovery | false | held | links3: roles=0; relevant: proxy: 1/3 of /(customer support/customer service/support specialist/suppor/; honest_links: proxy: 0/3 of /https?://\S+/ | search_query_polluted_by_count_or_constraint_words | 237 | 505 |
| C02 | empty | router | company_intel | false | held | roles: proxy: 0/3 of /patient access/patient services/medical (receptionist/assist/; training: proxy: 0/1 of /certificat\w*/certified/course\w*/CMAA/CPhT/\bCPC\b/CHAA/CRC/ | template_beats_requested_deliverable | 43 | 119 |
| C03 | empty | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 48 | 180 |
| C04 | empty | router | negotiation_draft | false | held | answers: proxy: 0/1 of /\b(yes/yes,/i would/i'd/worth (a )?counter\w*/don't counter//; asks_more: proxy: 0/1 of /\$\s?(2[5-9]/[3-9]\d)(\.\d\d)?\b/benefit/schedule/package/\b/; no_placeholder: proxy: matched "t", "h", "e" | template_beats_requested_deliverable | 26 | 78 |
| A1.1 | empty | router | career_discovery | false | held | ten: roles=0; relevant: proxy: 1/10 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 44 | 136 |
| A1.2 | empty | code_first | career_apply_queue | true | held |  |  | 0 | 42 |
| A1.3 | empty | router | career_list_reference | true | held |  |  | 13 | 85 |
| A1.4 | empty | router | career_batch_apply | true | held |  |  | 2 | 42 |
| A2.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 96 |
| A2.2 | empty | staged_brain | agent | unverified | held |  |  | 4 | 36 |
| A2.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 38 |
| A2.4 | empty | router | career_approval_rule | true | held |  |  | 10 | 96 |
| A3.1 | empty | router | career_tailor | true | held |  |  | 15 | 49 |
| A3.2 | empty | router | captcha_handoff | true | held |  |  | 1 | 34 |
| A3.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 48 |
| A3.4 | empty | staged_brain | agent | unverified | held |  |  | 6 | 37 |
| A4.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 40 |
| A4.2 | empty | router | connect_browser_source | false | held | not_connect: intent connect_browser_source; direct: proxy: 0/1 of /\bcloud\b/without (an /the )?extension/no extension/; must not say "LinkedIn" | greedy_keyword_matcher | 1 | 30 |
| A4.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 30 |
| A4.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 28 |
| A5.1 | empty | router | career_application_fields | true | held |  |  | 14 | 63 |
| A5.2 | empty | staged_brain | agent | unverified | held |  |  | 6 | 47 |
| A5.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 40 |
| A5.4 | empty | router | intent_sensitive_correction | true | held |  |  | 7 | 39 |
| A6.1 | empty | router | career_tailor | false | held | empty: does not say the record is missing | template_beats_requested_deliverable | 12 | 51 |
| A6.2 | empty | router | intent_refusal | false | held | on_topic: must not match /outreach/shortlist/verified emails/; ack: proxy: 0/1 of /\bSQL\b[^.]{0,80}\b(won't/will not/not/never/only)\b/\b(won'/ | negation_read_as_intent | 7 | 54 |
| A6.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 36 |
| A6.4 | empty | router | career_document_delivery | true | held |  |  | 6 | 38 |
| A7.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 28 |
| A7.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 21 |
| A7.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 23 |
| A7.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 23 |
| A8.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 41 |
| A8.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 22 |
| A8.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 24 |
| A8.4 | empty | router | career_discovery | true | held |  |  | 52 | 125 |
| A9.1 | empty | router | career_discovery | false | held | three: roles=0; relevant: proxy: 0/3 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 59 | 108 |
| A9.2 | empty | router | career_discovery | true | held |  |  | 55 | 92 |
| A9.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 60 |
| A9.4 | empty | router | career_discovery | true | held |  |  | 43 | 90 |
| A10.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 38 |
| A10.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 29 |
| A10.3 | empty | router | career_watch_manage | false | held | explains: proxy: 0/1 of /\bpause\b[^.]{0,80}\b(say/send/text/type/reply)\b/\b(say/sen/ | template_beats_requested_deliverable | 6 | 35 |
| A10.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 30 |
| A11.1 | empty | code_first | career_people_alumni | true | held |  |  | 0 | 35 |
| A11.2 | empty | staged_brain | agent | unverified | held |  |  | 10 | 35 |
| A11.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 24 |
| A11.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 21 |
| A12.1 | empty | code_first | career_networking_draft | false | held | draft: proxy: 0/1 of /subject:/\n\s*(hi/hello/dear)\b/\bwho\b[^.?]{0,60}\?/which (/ | template_beats_requested_deliverable | 0 | 31 |
| A12.2 | empty | staged_brain | agent | unverified | held |  |  | 1 | 28 |
| A12.3 | empty | code_first | career_networking_draft | false | held | ack: proxy: 0/1 of /\b(no/nothing/won't/will not/never)\b[^.]{0,50}\b(email/send/ | template_beats_requested_deliverable | 0 | 24 |
| A12.4 | empty | staged_brain | agent | unverified | held |  |  | 1 | 35 |
| A13.1 | empty | staged_brain | agent | unverified | held |  |  | 4 | 31 |
| A13.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 26 |
| A13.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 26 |
| A13.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 35 |
| A14.1 | empty | router | tracking_status | true | held |  |  | 16 | 51 |
| A14.2 | empty | code_first | career_apply_status | true | held |  |  | 0 | 28 |
| A14.3 | empty | code_first | career_activity | true | held |  |  | 0 | 19 |
| A14.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 25 |
| A15.1 | empty | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 15 | 46 |
| A15.2 | empty | router | prep_brief | false | held | no_invent: proxy: matched "question", "tomorrow", "interview"; must not say "scored input" | template_beats_requested_deliverable | 27 | 58 |
| A15.3 | empty | router | honest_unavailable | true | held |  |  | 5 | 50 |
| A15.4 | empty | router | prep_brief | false | held | one_q: questions=0; support: proxy: 0/1 of /customer/caller/ticket/upset/angry/complain\w*/escalat\w*/; must not say "Tell me about yourself" | template_beats_requested_deliverable | 15 | 74 |
| A16.1 | empty | router | path_plan | true | held |  |  | 24 | 63 |
| A16.2 | empty | staged_brain | agent | unverified | held |  |  | 12 | 46 |
| A16.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 45 |
| A16.4 | empty | staged_brain | agent | unverified | held |  |  | 3 | 34 |
| A17.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 38 |
| A17.2 | empty | staged_brain | agent | unverified | held |  |  | 3 | 56 |
| A17.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 54 |
| A17.4 | empty | code_first | conversation_redo | true | held |  |  | 0 | 25 |
| A18.1 | empty | router | conversation_recall | true | held |  |  | 18 | 61 |
| A18.2 | empty | staged_brain | agent | unverified | held |  |  | 4 | 38 |
| A18.3 | empty | staged_brain | agent | true | held |  |  | 2 | 36 |
| A18.4 | empty | staged_brain | agent | true | held |  |  | 4 | 39 |
| A19.1 | empty | router | career_onboarding_needs | true | held |  |  | 27 | 72 |
| A19.2 | empty | staged_brain | agent | unverified | held |  |  | 7 | 37 |
| A19.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 36 |
| A19.4 | empty | staged_brain | agent | unverified | held |  |  | 3 | 33 |
| A20.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 44 |
| A20.2 | empty | router | company_intel | false | held | not_intel: intent company_intel; on_topic: must not match /company file/company-file/; direct: proxy: 0/1 of /\b(yes/same (search/account/thread)/continue\w*/carries over/; must not say "company file" | greedy_keyword_matcher | 29 | 75 |
| A20.3 | empty | staged_brain | agent | unverified | held |  |  | 15 | 55 |
| A20.4 | empty | staged_brain | agent | unverified | held |  |  | 3 | 39 |
| A21.1 | empty | router | tracking_digest | false | held | explains: proxy: matched "digest: nothing has moved yet "; must not say "nothing has moved yet" | template_beats_requested_deliverable | 21 | 57 |
| A21.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 42 |
| A21.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 36 |
| A21.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 32 |
| A22.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 39 |
| A22.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 41 |
| A22.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 30 |
| A22.4 | empty | router | career_erase_confirm | true | held |  |  | 27 | 54 |
| A23.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 59 |
| A23.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 33 |
| A23.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 39 |
| A23.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 30 |
| A24.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 35 |
| A24.2 | empty | staged_brain | agent | unverified | held |  |  | 3 | 50 |
| A24.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 36 |
| A24.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 34 |
| A25.1 | empty | code_first | career_activity | true | held |  |  | 0 | 37 |
| A25.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 42 |
| A25.3 | empty | staged_brain | agent | unverified | held |  |  | 4 | 36 |
| A25.4 | empty | staged_brain | agent | unverified | held |  |  | 3 | 41 |
| C01 | seeded | router | career_discovery | false | held | links3: roles=0; relevant: proxy: 1/3 of /(customer support/customer service/support specialist/suppor/; honest_links: proxy: 0/3 of /https?://\S+/ | search_query_polluted_by_count_or_constraint_words | 123 | 200 |
| C02 | seeded | router | company_intel | false | held | roles: proxy: 0/3 of /patient access/patient services/medical (receptionist/assist/; training: proxy: 0/1 of /certificat\w*/certified/course\w*/CMAA/CPhT/\bCPC\b/CHAA/CRC/ | template_beats_requested_deliverable | 16 | 46 |
| C03 | seeded | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 15 | 41 |
| C04 | seeded | router | negotiation_draft | false | held | answers: proxy: 0/1 of /\b(yes/yes,/i would/i'd/worth (a )?counter\w*/don't counter//; asks_more: proxy: 0/1 of /\$\s?(2[5-9]/[3-9]\d)(\.\d\d)?\b/benefit/schedule/package/\b/; no_placeholder: proxy: matched "t", "h", "e" | template_beats_requested_deliverable | 12 | 39 |
| A1.1 | seeded | router | career_discovery | false | held | ten: roles=0; relevant: proxy: 1/10 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 84 | 123 |
| A1.2 | seeded | code_first | career_apply_queue | true | held |  |  | 0 | 42 |
| A1.3 | seeded | router | career_list_reference | false | held | binds: proxy: 0/1 of /skip\w*/remov\w*/dropp\w*/without/leaving/kept/rest of/ | missing_batch_executor_or_approval_binding, template_beats_requested_deliverable | 11 | 44 |
| A1.4 | seeded | router | career_batch_apply | true | held |  |  | 1 | 27 |
| A2.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 27 |
| A2.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 49 |
| A2.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 32 |
| A2.4 | seeded | router | career_approval_rule | true | held |  |  | 9 | 42 |
| A3.1 | seeded | router | packet_needs_role | false | held | asks: proxy: matched "name the role"; must not say "backend" | template_beats_requested_deliverable | 106 | 137 |
| A3.2 | seeded | router | captcha_handoff | true | held |  |  | 0 | 36 |
| A3.3 | seeded | router | portal_account | false | held | rule: proxy: 0/1 of /\b(you/yourself)\b[^.]{0,60}\b(sign in/sign up/create/log in/; must not say "alias" | template_beats_requested_deliverable | 16 | 57 |
| A3.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 33 |
| A4.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 30 |
| A4.2 | seeded | router | connect_browser_source | false | held | not_connect: intent connect_browser_source; direct: proxy: 0/1 of /\bcloud\b/without (an /the )?extension/no extension/; must not say "LinkedIn" | greedy_keyword_matcher | 0 | 35 |
| A4.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 32 |
| A4.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 30 |
| A5.1 | seeded | router | career_application_fields | true | held |  |  | 15 | 50 |
| A5.2 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 38 |
| A5.3 | seeded | staged_brain | agent | unverified | held |  |  | 4 | 34 |
| A5.4 | seeded | router | intent_sensitive_correction | true | held |  |  | 4 | 41 |
| A6.1 | seeded | router | career_tailor | false | held | role_match: /customer (support/service)/ | template_beats_requested_deliverable | 183 | 287 |
| A6.2 | seeded | router | intent_refusal | false | held | on_topic: must not match /outreach/shortlist/verified emails/; ack: proxy: 0/1 of /\bSQL\b[^.]{0,80}\b(won't/will not/not/never/only)\b/\b(won'/ | negation_read_as_intent | 14 | 59 |
| A6.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 39 |
| A6.4 | seeded | router | career_document_delivery | true | held |  |  | 9 | 50 |
| A7.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 43 |
| A7.2 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 30 |
| A7.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 28 |
| A7.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 21 |
| A8.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 25 |
| A8.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 23 |
| A8.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 33 |
| A8.4 | seeded | router | career_discovery | false | held | roles: roles=0 | search_query_polluted_by_count_or_constraint_words | 100 | 138 |
| A9.1 | seeded | router | career_discovery | false | held | three: roles=0; relevant: proxy: 0/3 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 284 | 181 |
| A9.2 | seeded | router | career_discovery | true | held |  |  | 85 | 282 |
| A9.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 39 |
| A9.4 | seeded | router | career_discovery | true | held |  |  | 100 | 167 |
| A10.1 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 33 |
| A10.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 27 |
| A10.3 | seeded | router | career_watch_manage | false | held | explains: proxy: 0/1 of /\bpause\b[^.]{0,80}\b(say/send/text/type/reply)\b/\b(say/sen/ | template_beats_requested_deliverable | 5 | 34 |
| A10.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 25 |
| A11.1 | seeded | code_first | career_people_alumni | true | held |  |  | 0 | 30 |
| A11.2 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 31 |
| A11.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 24 |
| A11.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 23 |
| A12.1 | seeded | code_first | career_networking_draft | false | held | draft: proxy: 0/1 of /subject:/\n\s*(hi/hello/dear)\b/\bwho\b[^.?]{0,60}\?/which (/ | template_beats_requested_deliverable | 0 | 17 |
| A12.2 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 34 |
| A12.3 | seeded | code_first | career_networking_draft | false | held | ack: proxy: 0/1 of /\b(no/nothing/won't/will not/never)\b[^.]{0,50}\b(email/send/ | template_beats_requested_deliverable | 0 | 16 |
| A12.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 21 |
| A13.1 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 24 |
| A13.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 29 |
| A13.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 54 |
| A13.4 | seeded | staged_brain | agent | unverified | held |  |  | 4 | 68 |
| A14.1 | seeded | router | tracking_status | true | held |  |  | 22 | 61 |
| A14.2 | seeded | code_first | career_apply_status | true | held |  |  | 0 | 25 |
| A14.3 | seeded | code_first | career_activity | true | held |  |  | 0 | 32 |
| A14.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 39 |
| A15.1 | seeded | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 65 | 86 |
| A15.2 | seeded | router | prep_brief | false | held | no_invent: proxy: matched "question", "tomorrow", "interview"; must not say "scored input" | template_beats_requested_deliverable | 35 | 86 |
| A15.3 | seeded | router | honest_unavailable | true | held |  |  | 11 | 66 |
| A15.4 | seeded | router | prep_brief | false | held | one_q: questions=0; support: proxy: 0/1 of /customer/caller/ticket/upset/angry/complain\w*/escalat\w*/; must not say "Tell me about yourself" | template_beats_requested_deliverable | 23 | 69 |
| A16.1 | seeded | router | path_plan | true | held |  |  | 15 | 52 |
| A16.2 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 59 |
| A16.3 | seeded | staged_brain | agent | unverified | held |  |  | 12 | 60 |
| A16.4 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 58 |
| A17.1 | seeded | staged_brain | agent | unverified | held |  |  | 17 | 55 |
| A17.2 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 36 |
| A17.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 37 |
| A17.4 | seeded | code_first | conversation_redo | true | held |  |  | 0 | 26 |
| A18.1 | seeded | router | conversation_recall | false | held | recall: proxy: 0/1 of /customer support/Chicago/ | template_beats_requested_deliverable | 32 | 64 |
| A18.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 39 |
| A18.3 | seeded | staged_brain | agent | true | held |  |  | 2 | 41 |
| A18.4 | seeded | staged_brain | agent | true | held |  |  | 3 | 50 |
| A19.1 | seeded | router | career_onboarding_needs | true | held |  |  | 18 | 72 |
| A19.2 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 45 |
| A19.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 44 |
| A19.4 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 42 |
| A20.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 45 |
| A20.2 | seeded | router | company_intel | false | held | not_intel: intent company_intel; on_topic: must not match /company file/company-file/; direct: proxy: 0/1 of /\b(yes/same (search/account/thread)/continue\w*/carries over/; must not say "company file" | greedy_keyword_matcher | 24 | 65 |
| A20.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 38 |
| A20.4 | seeded | staged_brain | agent | unverified | held |  |  | 4 | 37 |
| A21.1 | seeded | router | tracking_digest | false | held | explains: proxy: matched "digest: nothing has moved yet "; must not say "nothing has moved yet" | template_beats_requested_deliverable | 12 | 44 |
| A21.2 | seeded | staged_brain | agent | unverified | held |  |  | 17 | 62 |
| A21.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 36 |
| A21.4 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 40 |
| A22.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 36 |
| A22.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 50 |
| A22.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 41 |
| A22.4 | seeded | router | career_erase_confirm | true | held |  |  | 6 | 44 |
| A23.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 31 |
| A23.2 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 32 |
| A23.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 27 |
| A23.4 | seeded | router | portal_account | false | held | rule: proxy: 0/1 of /\b(won't/will not/never/can't/cannot/don't)\b[^.]{0,60}passw/; must not say "alias" | template_beats_requested_deliverable | 12 | 42 |
| A24.1 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 28 |
| A24.2 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 23 |
| A24.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 19 |
| A24.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 19 |
| A25.1 | seeded | code_first | career_activity | true | held |  |  | 0 | 14 |
| A25.2 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 23 |
| A25.3 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 24 |
| A25.4 | seeded | staged_brain | agent | unverified | held |  |  | 1 | 23 |
