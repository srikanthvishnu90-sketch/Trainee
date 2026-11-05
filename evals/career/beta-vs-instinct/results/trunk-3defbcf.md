# Beta vs Instinct scorecard: trunk-3defbcf

SHA `a2e7524bd067df42a5e1ee5cf520f004eabd8b98` · 2026-11-05T20:39:50.031Z · judge OFF (semantic criteria scored by deterministic proxies, score.ts proxy) · 1997s

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
| C01 | empty | router | career_discovery | false | held | links3: roles=0; relevant: proxy: 1/3 of /(customer support/customer service/support specialist/suppor/; honest_links: proxy: 0/3 of /https?://\S+/ | search_query_polluted_by_count_or_constraint_words | 926 | 646 |
| C02 | empty | router | company_intel | false | held | roles: proxy: 0/3 of /patient access/patient services/medical (receptionist/assist/; training: proxy: 0/1 of /certificat\w*/certified/course\w*/CMAA/CPhT/\bCPC\b/CHAA/CRC/ | template_beats_requested_deliverable | 320 | 184 |
| C03 | empty | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 82 | 209 |
| C04 | empty | router | negotiation_draft | false | held | answers: proxy: 0/1 of /\b(yes/yes,/i would/i'd/worth (a )?counter\w*/don't counter//; asks_more: proxy: 0/1 of /\$\s?(2[5-9]/[3-9]\d)(\.\d\d)?\b/benefit/schedule/package/\b/; no_placeholder: proxy: matched "t", "h", "e" | template_beats_requested_deliverable | 75 | 109 |
| A1.1 | empty | router | career_discovery | false | held | ten: roles=0; relevant: proxy: 1/10 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 177 | 183 |
| A1.2 | empty | code_first | career_apply_queue | true | held |  |  | 0 | 60 |
| A1.3 | empty | router | career_list_reference | true | held |  |  | 43 | 136 |
| A1.4 | empty | router | career_batch_apply | true | held |  |  | 21 | 73 |
| A2.1 | empty | staged_brain | agent | unverified | held |  |  | 21 | 126 |
| A2.2 | empty | staged_brain | agent | unverified | held |  |  | 11 | 64 |
| A2.3 | empty | staged_brain | agent | unverified | held |  |  | 4 | 55 |
| A2.4 | empty | router | career_approval_rule | true | held |  |  | 14 | 77 |
| A3.1 | empty | router | career_tailor | true | held |  |  | 30 | 74 |
| A3.2 | empty | router | captcha_handoff | true | held |  |  | 1 | 45 |
| A3.3 | empty | staged_brain | agent | unverified | held |  |  | 13 | 57 |
| A3.4 | empty | staged_brain | agent | unverified | held |  |  | 7 | 51 |
| A4.1 | empty | staged_brain | agent | unverified | held |  |  | 5 | 52 |
| A4.2 | empty | router | connect_browser_source | false | held | not_connect: intent connect_browser_source; direct: proxy: 0/1 of /\bcloud\b/without (an /the )?extension/no extension/; must not say "LinkedIn" | greedy_keyword_matcher | 3 | 49 |
| A4.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 45 |
| A4.4 | empty | staged_brain | agent | unverified | held |  |  | 5 | 56 |
| A5.1 | empty | router | career_application_fields | true | held |  |  | 74 | 86 |
| A5.2 | empty | staged_brain | agent | unverified | held |  |  | 11 | 67 |
| A5.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 51 |
| A5.4 | empty | router | intent_sensitive_correction | true | held |  |  | 5 | 52 |
| A6.1 | empty | router | career_tailor | false | held | empty: does not say the record is missing | template_beats_requested_deliverable | 25 | 73 |
| A6.2 | empty | router | intent_refusal | false | held | on_topic: must not match /outreach/shortlist/verified emails/; ack: proxy: 0/1 of /\bSQL\b[^.]{0,80}\b(won't/will not/not/never/only)\b/\b(won'/ | negation_read_as_intent | 43 | 93 |
| A6.3 | empty | staged_brain | agent | unverified | held |  |  | 46 | 54 |
| A6.4 | empty | router | career_document_delivery | true | held |  |  | 22 | 67 |
| A7.1 | empty | staged_brain | agent | unverified | held |  |  | 10 | 52 |
| A7.2 | empty | staged_brain | agent | unverified | held |  |  | 9 | 53 |
| A7.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 117 |
| A7.4 | empty | staged_brain | agent | unverified | held |  |  | 3 | 116 |
| A8.1 | empty | staged_brain | agent | unverified | held |  |  | 12 | 59 |
| A8.2 | empty | staged_brain | agent | unverified | held |  |  | 9 | 47 |
| A8.3 | empty | staged_brain | agent | unverified | held |  |  | 13 | 116 |
| A8.4 | empty | router | career_discovery | true | held |  |  | 155 | 182 |
| A9.1 | empty | router | career_discovery | false | held | three: roles=0; relevant: proxy: 0/3 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 186 | 131 |
| A9.2 | empty | router | career_discovery | true | held |  |  | 219 | 106 |
| A9.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 49 |
| A9.4 | empty | router | career_discovery | true | held |  |  | 194 | 183 |
| A10.1 | empty | staged_brain | agent | unverified | held |  |  | 9 | 117 |
| A10.2 | empty | staged_brain | agent | unverified | held |  |  | 3 | 87 |
| A10.3 | empty | router | career_watch_manage | false | held | explains: proxy: 0/1 of /\bpause\b[^.]{0,80}\b(say/send/text/type/reply)\b/\b(say/sen/ | template_beats_requested_deliverable | 15 | 55 |
| A10.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 89 |
| A11.1 | empty | code_first | career_people_alumni | true | held |  |  | 0 | 35 |
| A11.2 | empty | staged_brain | agent | unverified | held |  |  | 50 | 113 |
| A11.3 | empty | staged_brain | agent | unverified | held |  |  | 8 | 50 |
| A11.4 | empty | staged_brain | agent | unverified | held |  |  | 5 | 44 |
| A12.1 | empty | code_first | career_networking_draft | false | held | draft: proxy: 0/1 of /subject:/\n\s*(hi/hello/dear)\b/\bwho\b[^.?]{0,60}\?/which (/ | template_beats_requested_deliverable | 0 | 75 |
| A12.2 | empty | staged_brain | agent | unverified | held |  |  | 14 | 54 |
| A12.3 | empty | code_first | career_networking_draft | false | held | ack: proxy: 0/1 of /\b(no/nothing/won't/will not/never)\b[^.]{0,50}\b(email/send/ | template_beats_requested_deliverable | 0 | 41 |
| A12.4 | empty | staged_brain | agent | unverified | held |  |  | 3 | 130 |
| A13.1 | empty | staged_brain | agent | unverified | held |  |  | 6 | 47 |
| A13.2 | empty | staged_brain | agent | unverified | held |  |  | 7 | 57 |
| A13.3 | empty | staged_brain | agent | unverified | held |  |  | 58 | 64 |
| A13.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 132 |
| A14.1 | empty | router | tracking_status | true | held |  |  | 65 | 156 |
| A14.2 | empty | code_first | career_apply_status | true | held |  |  | 0 | 46 |
| A14.3 | empty | code_first | career_activity | true | held |  |  | 0 | 124 |
| A14.4 | empty | staged_brain | agent | unverified | held |  |  | 11 | 111 |
| A15.1 | empty | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 95 | 131 |
| A15.2 | empty | router | prep_brief | false | held | no_invent: proxy: matched "question", "tomorrow", "interview"; must not say "scored input" | template_beats_requested_deliverable | 88 | 132 |
| A15.3 | empty | router | honest_unavailable | true | held |  |  | 11 | 60 |
| A15.4 | empty | router | prep_brief | false | held | one_q: questions=0; support: proxy: 0/1 of /customer/caller/ticket/upset/angry/complain\w*/escalat\w*/; must not say "Tell me about yourself" | template_beats_requested_deliverable | 74 | 148 |
| A16.1 | empty | router | path_plan | true | held |  |  | 90 | 80 |
| A16.2 | empty | staged_brain | agent | unverified | held |  |  | 16 | 127 |
| A16.3 | empty | staged_brain | agent | unverified | held |  |  | 11 | 116 |
| A16.4 | empty | staged_brain | agent | unverified | held |  |  | 7 | 57 |
| A17.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 128 |
| A17.2 | empty | staged_brain | agent | unverified | held |  |  | 5 | 63 |
| A17.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 58 |
| A17.4 | empty | code_first | conversation_redo | true | held |  |  | 0 | 31 |
| A18.1 | empty | router | conversation_recall | true | held |  |  | 28 | 150 |
| A18.2 | empty | staged_brain | agent | unverified | held |  |  | 15 | 130 |
| A18.3 | empty | staged_brain | agent | unverified | held |  |  | 10 | 133 |
| A18.4 | empty | staged_brain | agent | unverified | held |  |  | 6 | 49 |
| A19.1 | empty | router | career_onboarding_needs | true | held |  |  | 48 | 150 |
| A19.2 | empty | staged_brain | agent | unverified | held |  |  | 4 | 49 |
| A19.3 | empty | staged_brain | agent | unverified | held |  |  | 6 | 133 |
| A19.4 | empty | staged_brain | agent | unverified | held |  |  | 13 | 52 |
| A20.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 51 |
| A20.2 | empty | router | company_intel | false | held | not_intel: intent company_intel; on_topic: must not match /company file/company-file/; direct: proxy: 0/1 of /\b(yes/same (search/account/thread)/continue\w*/carries over/; must not say "company file" | greedy_keyword_matcher | 86 | 173 |
| A20.3 | empty | staged_brain | agent | unverified | held |  |  | 15 | 49 |
| A20.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 98 |
| A21.1 | empty | router | tracking_digest | false | held | explains: proxy: matched "digest: nothing has moved yet "; must not say "nothing has moved yet" | template_beats_requested_deliverable | 16 | 123 |
| A21.2 | empty | staged_brain | agent | unverified | held |  |  | 5 | 99 |
| A21.3 | empty | staged_brain | agent | unverified | held |  |  | 4 | 35 |
| A21.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 94 |
| A22.1 | empty | staged_brain | agent | unverified | held |  |  | 3 | 35 |
| A22.2 | empty | staged_brain | agent | unverified | held |  |  | 2 | 39 |
| A22.3 | empty | staged_brain | agent | unverified | held |  |  | 3 | 101 |
| A22.4 | empty | router | career_erase_confirm | true | held |  |  | 13 | 47 |
| A23.1 | empty | staged_brain | agent | unverified | held |  |  | 2 | 46 |
| A23.2 | empty | staged_brain | agent | unverified | held |  |  | 4 | 94 |
| A23.3 | empty | staged_brain | agent | unverified | held |  |  | 8 | 106 |
| A23.4 | empty | staged_brain | agent | unverified | held |  |  | 10 | 111 |
| A24.1 | empty | staged_brain | agent | unverified | held |  |  | 4 | 36 |
| A24.2 | empty | staged_brain | agent | unverified | held |  |  | 3 | 94 |
| A24.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 35 |
| A24.4 | empty | staged_brain | agent | unverified | held |  |  | 2 | 35 |
| A25.1 | empty | code_first | career_activity | true | held |  |  | 0 | 101 |
| A25.2 | empty | staged_brain | agent | unverified | held |  |  | 3 | 37 |
| A25.3 | empty | staged_brain | agent | unverified | held |  |  | 2 | 42 |
| A25.4 | empty | staged_brain | agent | unverified | held |  |  | 10 | 104 |
| C01 | seeded | router | career_discovery | false | held | links3: roles=0; relevant: proxy: 1/3 of /(customer support/customer service/support specialist/suppor/; honest_links: proxy: 0/3 of /https?://\S+/ | search_query_polluted_by_count_or_constraint_words | 405 | 337 |
| C02 | seeded | router | company_intel | false | held | roles: proxy: 0/3 of /patient access/patient services/medical (receptionist/assist/; training: proxy: 0/1 of /certificat\w*/certified/course\w*/CMAA/CPhT/\bCPC\b/CHAA/CRC/ | template_beats_requested_deliverable | 70 | 80 |
| C03 | seeded | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 45 | 64 |
| C04 | seeded | router | negotiation_draft | false | held | answers: proxy: 0/1 of /\b(yes/yes,/i would/i'd/worth (a )?counter\w*/don't counter//; asks_more: proxy: 0/1 of /\$\s?(2[5-9]/[3-9]\d)(\.\d\d)?\b/benefit/schedule/package/\b/; no_placeholder: proxy: matched "t", "h", "e" | template_beats_requested_deliverable | 17 | 55 |
| A1.1 | seeded | router | career_discovery | false | held | ten: roles=0; relevant: proxy: 1/10 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 318 | 206 |
| A1.2 | seeded | code_first | career_apply_queue | true | held |  |  | 0 | 73 |
| A1.3 | seeded | router | career_list_reference | false | held | binds: proxy: 0/1 of /skip\w*/remov\w*/dropp\w*/without/leaving/kept/rest of/ | missing_batch_executor_or_approval_binding, template_beats_requested_deliverable | 144 | 90 |
| A1.4 | seeded | router | career_batch_apply | true | held |  |  | 3 | 41 |
| A2.1 | seeded | staged_brain | agent | unverified | held |  |  | 8 | 67 |
| A2.2 | seeded | staged_brain | agent | unverified | held |  |  | 12 | 66 |
| A2.3 | seeded | staged_brain | agent | unverified | held |  |  | 6 | 62 |
| A2.4 | seeded | router | career_approval_rule | true | held |  |  | 9 | 47 |
| A3.1 | seeded | router | packet_needs_role | false | held | asks: proxy: matched "name the role"; must not say "backend" | template_beats_requested_deliverable | 546 | 198 |
| A3.2 | seeded | router | captcha_handoff | true | held |  |  | 1 | 47 |
| A3.3 | seeded | router | portal_account | false | held | rule: proxy: 0/1 of /\b(you/yourself)\b[^.]{0,60}\b(sign in/sign up/create/log in/; must not say "alias" | template_beats_requested_deliverable | 22 | 99 |
| A3.4 | seeded | staged_brain | agent | unverified | held |  |  | 29 | 157 |
| A4.1 | seeded | staged_brain | agent | unverified | held |  |  | 4 | 37 |
| A4.2 | seeded | router | connect_browser_source | false | held | not_connect: intent connect_browser_source; direct: proxy: 0/1 of /\bcloud\b/without (an /the )?extension/no extension/; must not say "LinkedIn" | greedy_keyword_matcher | 0 | 42 |
| A4.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 37 |
| A4.4 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 35 |
| A5.1 | seeded | router | career_application_fields | true | held |  |  | 55 | 72 |
| A5.2 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 48 |
| A5.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 32 |
| A5.4 | seeded | router | intent_sensitive_correction | true | held |  |  | 6 | 48 |
| A6.1 | seeded | router | career_tailor | false | held | role_match: /customer (support/service)/ | template_beats_requested_deliverable | 236 | 270 |
| A6.2 | seeded | router | intent_refusal | false | held | on_topic: must not match /outreach/shortlist/verified emails/; ack: proxy: 0/1 of /\bSQL\b[^.]{0,80}\b(won't/will not/not/never/only)\b/\b(won'/ | negation_read_as_intent | 12 | 48 |
| A6.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 45 |
| A6.4 | seeded | router | career_document_delivery | true | held |  |  | 29 | 67 |
| A7.1 | seeded | staged_brain | agent | unverified | held |  |  | 4 | 40 |
| A7.2 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 40 |
| A7.3 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 33 |
| A7.4 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 38 |
| A8.1 | seeded | staged_brain | agent | unverified | held |  |  | 19 | 44 |
| A8.2 | seeded | staged_brain | agent | unverified | held |  |  | 11 | 58 |
| A8.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 44 |
| A8.4 | seeded | router | career_discovery | false | held | roles: roles=0 | search_query_polluted_by_count_or_constraint_words | 105 | 133 |
| A9.1 | seeded | router | career_discovery | false | held | three: roles=0; relevant: proxy: 0/3 of /(customer support/customer service/support specialist/suppor/ | search_query_polluted_by_count_or_constraint_words | 154 | 146 |
| A9.2 | seeded | router | career_discovery | true | held |  |  | 397 | 184 |
| A9.3 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 63 |
| A9.4 | seeded | router | career_discovery | true | held |  |  | 402 | 299 |
| A10.1 | seeded | staged_brain | agent | unverified | held |  |  | 60 | 69 |
| A10.2 | seeded | staged_brain | agent | unverified | held |  |  | 25 | 57 |
| A10.3 | seeded | router | career_watch_manage | false | held | explains: proxy: 0/1 of /\bpause\b[^.]{0,80}\b(say/send/text/type/reply)\b/\b(say/sen/ | template_beats_requested_deliverable | 13 | 55 |
| A10.4 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 67 |
| A11.1 | seeded | code_first | career_people_alumni | true | held |  |  | 0 | 49 |
| A11.2 | seeded | staged_brain | agent | unverified | held |  |  | 9 | 42 |
| A11.3 | seeded | staged_brain | agent | unverified | held |  |  | 6 | 37 |
| A11.4 | seeded | staged_brain | agent | unverified | held |  |  | 4 | 42 |
| A12.1 | seeded | code_first | career_networking_draft | false | held | draft: proxy: 0/1 of /subject:/\n\s*(hi/hello/dear)\b/\bwho\b[^.?]{0,60}\?/which (/ | template_beats_requested_deliverable | 0 | 34 |
| A12.2 | seeded | staged_brain | agent | unverified | held |  |  | 6 | 59 |
| A12.3 | seeded | code_first | career_networking_draft | false | held | ack: proxy: 0/1 of /\b(no/nothing/won't/will not/never)\b[^.]{0,50}\b(email/send/ | template_beats_requested_deliverable | 0 | 27 |
| A12.4 | seeded | staged_brain | agent | unverified | held |  |  | 9 | 43 |
| A13.1 | seeded | staged_brain | agent | unverified | held |  |  | 4 | 35 |
| A13.2 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 41 |
| A13.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 39 |
| A13.4 | seeded | staged_brain | agent | unverified | held |  |  | 32 | 72 |
| A14.1 | seeded | router | tracking_status | true | held |  |  | 39 | 71 |
| A14.2 | seeded | code_first | career_apply_status | true | held |  |  | 0 | 27 |
| A14.3 | seeded | code_first | career_activity | true | held |  |  | 0 | 30 |
| A14.4 | seeded | staged_brain | agent | unverified | held |  |  | 2 | 37 |
| A15.1 | seeded | router | prep_brief | false | held | file: no File or document came back; five_q: questions=1; plan30: proxy: 0/3 of /\b\d{1,2}\s*(?:-/–/to)?\s*(?:\d{1,2}\s*)?(?:min/minutes)\b/ | missing_artifact_path, template_beats_requested_deliverable | 202 | 78 |
| A15.2 | seeded | router | prep_brief | false | held | no_invent: proxy: matched "question", "tomorrow", "interview"; must not say "scored input" | template_beats_requested_deliverable | 39 | 71 |
| A15.3 | seeded | router | honest_unavailable | true | held |  |  | 10 | 71 |
| A15.4 | seeded | router | prep_brief | false | held | one_q: questions=0; support: proxy: 0/1 of /customer/caller/ticket/upset/angry/complain\w*/escalat\w*/; must not say "Tell me about yourself" | template_beats_requested_deliverable | 31 | 58 |
| A16.1 | seeded | router | path_plan | true | held |  |  | 61 | 83 |
| A16.2 | seeded | staged_brain | agent | unverified | held |  |  | 53 | 76 |
| A16.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 66 |
| A16.4 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 39 |
| A17.1 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 43 |
| A17.2 | seeded | staged_brain | agent | unverified | held |  |  | 6 | 55 |
| A17.3 | seeded | staged_brain | agent | unverified | held |  |  | 8 | 60 |
| A17.4 | seeded | code_first | conversation_redo | true | held |  |  | 0 | 46 |
| A18.1 | seeded | router | conversation_recall | false | held | recall: proxy: 0/1 of /customer support/Chicago/ | template_beats_requested_deliverable | 402 | 105 |
| A18.2 | seeded | staged_brain | agent | unverified | held |  |  | 22 | 69 |
| A18.3 | seeded | staged_brain | agent | unverified | held |  |  | 12 | 67 |
| A18.4 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 56 |
| A19.1 | seeded | router | career_onboarding_needs | true | held |  |  | 16 | 59 |
| A19.2 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 53 |
| A19.3 | seeded | staged_brain | agent | unverified | held |  |  | 20 | 60 |
| A19.4 | seeded | staged_brain | agent | unverified | held |  |  | 11 | 57 |
| A20.1 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 43 |
| A20.2 | seeded | router | company_intel | false | held | not_intel: intent company_intel; on_topic: must not match /company file/company-file/; direct: proxy: 0/1 of /\b(yes/same (search/account/thread)/continue\w*/carries over/; must not say "company file" | greedy_keyword_matcher | 89 | 79 |
| A20.3 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 61 |
| A20.4 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 38 |
| A21.1 | seeded | router | tracking_digest | false | held | explains: proxy: matched "digest: nothing has moved yet "; must not say "nothing has moved yet" | template_beats_requested_deliverable | 24 | 62 |
| A21.2 | seeded | staged_brain | agent | unverified | held |  |  | 21 | 64 |
| A21.3 | seeded | staged_brain | agent | unverified | held |  |  | 8 | 70 |
| A21.4 | seeded | staged_brain | agent | unverified | held |  |  | 13 | 54 |
| A22.1 | seeded | staged_brain | agent | unverified | held |  |  | 24 | 76 |
| A22.2 | seeded | staged_brain | agent | unverified | held |  |  | 14 | 76 |
| A22.3 | seeded | staged_brain | agent | unverified | held |  |  | 58 | 80 |
| A22.4 | seeded | router | career_erase_confirm | true | held |  |  | 22 | 68 |
| A23.1 | seeded | staged_brain | agent | unverified | held |  |  | 7 | 50 |
| A23.2 | seeded | staged_brain | agent | unverified | held |  |  | 18 | 66 |
| A23.3 | seeded | staged_brain | agent | unverified | held |  |  | 10 | 74 |
| A23.4 | seeded | router | portal_account | false | held | rule: proxy: 0/1 of /\b(won't/will not/never/can't/cannot/don't)\b[^.]{0,60}passw/; must not say "alias" | template_beats_requested_deliverable | 79 | 85 |
| A24.1 | seeded | staged_brain | agent | unverified | held |  |  | 22 | 59 |
| A24.2 | seeded | staged_brain | agent | unverified | held |  |  | 24 | 69 |
| A24.3 | seeded | staged_brain | agent | unverified | held |  |  | 15 | 58 |
| A24.4 | seeded | staged_brain | agent | unverified | held |  |  | 17 | 67 |
| A25.1 | seeded | code_first | career_activity | true | held |  |  | 0 | 45 |
| A25.2 | seeded | staged_brain | agent | unverified | held |  |  | 5 | 51 |
| A25.3 | seeded | staged_brain | agent | unverified | held |  |  | 3 | 30 |
| A25.4 | seeded | staged_brain | agent | unverified | held |  |  | 29 | 87 |
