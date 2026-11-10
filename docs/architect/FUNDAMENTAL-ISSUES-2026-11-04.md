# Fundamental issues, 2026-11-04

This is a ranked list of the product's fundamental issues on trunk `d3ac642`. "Fundamental" means the issue stops a
real person from finding roles, applying at volume, networking, connecting accounts, getting a File or link, or getting
a reply that answers what they asked. Cosmetic issues are not listed. The list has **59 issues**; it is not padded, and
some issues group several symptoms that share one root cause.

The bar is the owner's: comprehension, answer quality and design that compete with Claude Opus 5.5, and real tasks done
the way Instinct or Muse do them.


> **Baseline.** Recorded on trunk `d3ac642` (`results/trunk-d3ac642.*`, scorecards and full records). Earlier runs on `e6696cb`, `4158a1a` and `3defbcf` gave the same headline. **Role counter (follow-up to #516):** the role-results page is stored as an array of refs under `tg:list:<id>`, with its rows under `tg:job:<ref>`. The counter used to expect an object and read 0 roles, so it now reads the stored rows (`score.ts pageRoles`), and the relevance check reads them as page content. On trunk this changes only A9.2 seeded (0 to 6 roles; it was already delivered). File:line references are as of `e6696cb`; #493 (the CPU fix, merged since) shifts `handler-career.ts` and `142-career-router.js` by up to about 130 lines, so search by the function name. **Scoring rule (review of #516):** on a staged-brain record, `not_generic` and `not_mentions` are unmeasured, so a brain record is never counted as delivered. This took A18.3 and A18.4 out of "delivered", in both states.

## The numbers behind it

Benchmark: `evals/career/beta-vs-instinct/`. It runs the 104 beta inputs through the real handler, in two account
states, with no paid call.

- **Task completion (primary metric).** 22.1% (empty account) and 18.3% (seeded). That is 23 and 19 of 104 prompts
  with every requested deliverable verifiably produced. 17 and 23 failed one. 64 and 62 were answered by the staged
  brain and can't be verified offline. Guards (nothing sent, nothing written, profile unchanged) held on 208 of 208.
- **Quality against Opus 5.5 (quality metric).** On code-answered turns, Trainee won 1, tied 1 and lost 80 of 82. The
  Opus references are cached in `opus-refs.json`. The judge was Haiku, pairwise and position-balanced, through the
  Claude CLI on the subscription.

  | dimension | win | tie | loss |
  |---|---|---|---|
  | ask (understood) | 1 | 23 | 58 |
  | delivered | 4 | 21 | 57 |
  | correct | 3 | 16 | 63 |
  | texting | 9 | 11 | 62 |
  | next step | 14 | 17 | 51 |

  All 26 feature groups lose or have no comparable turn. The 126 brain turns are not compared, because offline they
  carry scripted text.
- **Live beta (report).** 0 of 4 full passes. 1 of 4 died on CPU.
- Per-record detail: `evals/career/beta-vs-instinct/results/trunk-d3ac642.md` and `.opus.md`. Grouped failures:
  `docs/architect/BETA-FAILURE-MAP-2026-11-04.md`.

## Legend

- **Impact codes.** R = finding roles; A = applying at volume; N = networking; C = connecting accounts; F = Files and
  links; T = responses and conversation design (talk).
- **Effort.** S = under a day; M = 1-3 days; L = a week or more, or an owner or external dependency.
- **In-flight codes.** The fixes in flight are:
  - CPU = `fix/c01-agent-chat-cpu-budget`
  - PRE = `fix/router-constraint-deliverable-prepass`
  - PREP = `feat/prep-file-artifact`
  - C04 = `fix/draft-deliverables-c04`
  - MASS = `fix/mass-apply-end-to-end`

  "Measured" means the benchmark was run on that branch (see the last section). "Scope" means the branch touches the
  file but was not measured. "—" means no fix in flight.
- **Line numbers.** `142:` is `packages/domain/142-career-router.js` (the router's source of truth; the bundle
  `_shared/router_core.career.js` is generated from it). `_s/` is `supabase/functions/_shared/`, and `ac/` is
  `supabase/functions/agent-chat/`.

## Ranked inventory

### Tier 1: the person asks and gets nothing usable (blocks the core loop)

| # | title | user-visible symptom | root cause (file:line) | evidence | impact | effort | in flight |
|---|---|---|---|---|---|---|---|
| F01 | The search role keeps count, constraint and filler words | "Find three … jobs … Do not apply" gets "I found no posting for three realistic … send links do contact anyone", while 14 matches exist | `_s/posting_constraints.ts:81` (`ROLE_NOISE` lacks counts, "only", constraint verbs), `:85-106` (`searchTextOf` strips only "apply"), `_s/career_search_judge.ts:448` | C01, A1.1, A9.1 (both states), A8.4, A9.2; judge loss on all of them | R A | S | #522 `fix/search-terms-count-F01-F03` (measured: C01, A1.1, A9.1 and A8.4 delivered) |
| F02 | One junk word empties the whole search | Every word must match, so any leftover word gives zero rows; the reply says the board "has no match" | `_s/career_search_judge.ts:293-297` (websearch AND of every lexeme), `:306-314` (one `ilike` per word) | C01; Opus reference lists 3 real board links for the same input | R | S | — |
| F03 | The requested count is ignored | "find 3" lists 8; "ten" is read as a role word; "apply to all those" then queues 8 | `_s/career_search_judge.ts:416` (`show` default 8), `ac/handler-career.ts:1124` (no `show` passed), `142:501-502` (digit needed before "jobs"), `_s/posting_constraints.ts:105` (digits dropped) | seed turn 6, A1.1, A1.2 seeded "8/8 queued" | R A | S | — |
| F04 | Negation is never read when routing | "Do not apply/contact/invent" triggers the forbidden thing's handler: application fields (live C02), a fabrication refusal (A6.2), company "and" (C02 trunk) | `142:12232` (`career_application_fields` bag of words), `142:4413` (`handleRefusal`), `142:4643-4644` (`companyFromText` "contact anyone"), `_s/posting_constraints.ts:81` ("not" dropped as noise) | live C02, C02, A6.2, A9.4 | T R | M | PRE (scope) |
| F05 | A template wins over the requested deliverable | Asks for "five questions", "a File", "a 30-minute plan", "draft for review" or "should I counter" get the family template instead | no deliverable contract: `ac/career_staged.ts:221,282` (a File ask "stays a search"), `142:6227-6229` (3 questions), `142:7798` (draft without an answer) | C03, C04, A15.1, A15.4 (both states); "delivered" lost 57 of 82 | F T | L | PRE + PREP + C04 (partial) |
| F06 | Most asks have no code handler and fall to the brain or a generic text | 126 of 208 turns go to the staged brain (catchall 76, unclaimed 40). With no key or on a model error they get "I'm Trainee, a career agent … I may have missed what you meant" (44/100 at `03edad4`) | `ac/career_staged.ts:36-45`, `packages/domain/143-career-containment.js:154`, `packages/domain/140-career-reply.js:129`, `142:3508` (catchall), `ac/handler-career.ts:1090-1093` | benchmark layer table; release report A2-A25 | T | L | — |
| F07 | The brain has no File tool at release | Any File ask the brain takes cannot produce a File | `ac/career_brain.ts:142` (`create_file` only when `shape && files`), `ac/handler-career.ts:1072` (`shape` = writer on and telegram), `ac/release_config.ts:149-155` (`CAREER_REPLY_WRITER` never on) | 0 of 126 brain turns were offered `create_file`/`attach_document` | F | S | — |
| F08 | The batch executor is not deployed: mass apply queues and stops | "Apply to all" says "8/8 queued … I'll show you each application's exact answers on a card"; no card comes unless the cloud runner secrets are set | `ac/release_config.ts:138-142` (`CAREER_BATCH_EXECUTOR` pending), `_s/career_apply_from_chat.ts:122-140` (`kickPrepare` off without `CAREER_PREPARE_AHEAD_*`), `scripts/launch/trainee-go-live.sh:864-890` (runner needs `VERCEL_TOKEN`) | A1.2 seeded; MASS-APPLY specs | A | L | MASS (scope: `batch-executor-main.cjs`, the honest not-started reply) |
| F09 | Two queues that don't see each other | After "8/8 queued", "show the batch progress" says no batch exists, and "what did you send / where are my applications" leaves out queued postings | `142:12861-12887` (`handleBatchStatus` reads only the router batch stack, reply `:12886`), `_s/career_apply_status.ts:30` and `_s/career_activity.ts` (read only `career_apply_jobs`; 0 reads of `career_apply_wanted`) | code read; ROOT-CAUSES-2026-10-31 §2 (8 apply paths) | A | M | MASS (scope: `157-career-apply-ledger.js`, `career_apply_status.ts`) |
| F10 | The live turn has no CPU budget | Live C01 died with HTTP 546 at 2,142 ms CPU; the person got a generic error | `ac/handler-career.ts` (no clock); the bundle's `timeout` fallback text has no trigger | live C01 execution `3dcc107d` | R T | M | CPU (scope: `turn_clock.ts`) |
| F11 | Three router runs and two deep copies per router turn | 3x router cost on 65 of 208 records | `ac/career_staged.ts:271` (staged probe), `ac/career_pool_need.ts:23-30` (pool probe), `ac/handler-career.ts:1114` (real run) | benchmark trace: router_calls = 3 | R | M | CPU (measured below) |
| F12 | A 600-row synchronous pool map on every turn | Each turn does CPU work the turn doesn't need | `_s/career_pool.js:58` (`DEFAULT_LIMIT = 600`), `:135-156` (`loadPool` maps every row), `:89-119` | C01 is the heaviest local turn (410 ms) | R | M | CPU (scope) |

### Tier 2: the person gets an answer to a different question, or a wrong fact

| # | title | user-visible symptom | root cause (file:line) | evidence | impact | effort | in flight |
|---|---|---|---|---|---|---|---|
| F13 | The company-intel gate fires on any "?" or "what" and mints companies from words | "and has no company file yet"; "Telegram has no company file yet" | `142:14007` (gate), `142:4643-4644` ("look at and"), `142:6638` (any capital after "on"), `142:6727` | C02, A20.2 (both states) | T | S | PRE (measured: moves both to the brain, so they are unverified, not fixed in code) |
| F14 | Counter draft: "the firm" placeholder, and the ask is the offered figure | "Dear the firm team … It asks for $24 an hour" for a $24 offer | `142:7841` (`"the firm"`), `142:7839,7847` (`parseOfferFigures` of this turn), `142:3686-3698` | C04 (both states), live C04 | T | S | C04 (measured: C04 delivered in both states) |
| F15 | "Should I counter?" is never answered | The draft comes with no yes/no/depends | `142:7798` (the draft trigger returns the draft only) | C04, A16.2 (brain) | T | S | C04 (measured: "Yes, counter once, in writing, at $26 an hour") |
| F16 | Offer parsing misses the title and converts hourly to annual | "Got it: Northwind Health, Chicago metro, $49,920. … I need the job title" when the title was in the sentence | `_s/career_offer.ts:104-110` (`ROLE_WORDS` fixed list), `:157` (`value * 2080`), `_s/career_offer_chat.ts:58-63` | seed turn 3 | T | S | C04 (scope: `career_offer.ts`, `career_offer_chat.ts`) |
| F17 | Tailoring binds an unrelated posting | "Tailor my resume for customer support" produced a resume for "Software Engineer Intern at Synthco 232" | `142:13724-13728` (tailor through an unfiltered `handleDiscovery`), `142:481-489`, `packages/domain/121-career-jobs.js:88-127` (no support family) | A6.1 seeded | A F | M | — (open PR #382 "tailor target" is not in this list) |
| F18 | The role-family taxonomy has no support, healthcare or service families | Non-tech asks rank badly, tailor to the wrong role, and get generic prep | `121-career-jobs.js:88-127`, `142:5917-5954` (`INTERVIEW_FAMILIES`) | A6.1, A15.4, C02 | R A | M | CPU (scope: `121-career-jobs.js`) |
| F19 | The packet target defaults to "backend" | "Prepare this Greenhouse application" with a support list on record: "no backend role in the current list" | `142:1186` (`handlePacket` descriptor default) | A3.1 seeded | A | S | — |
| F20 | "Explain how to delete my data without doing it" arms the erase | The next "yes" erases the career profile | `142:3171-3182` (`handleErasePath` has no explain/without check) | A22.4 | T | S | — |
| F21 | Explain questions are treated as commands | "How can I pause alerts?" gets "You have no job watches"; "What is in a weekly digest?" gets "nothing has moved yet" | `142:11370`, `:11407-11410` (`handleWatchManage`), `142:9387-9394` (`handleTrackDigest`) | A10.3, A21.1 (both states) | T | S | — |
| F22 | Portal copy says Trainee creates logins, but no code does | "the account is created as a record … no alias, no password gets generated until you confirm the account card"; another account's password gets the same text | `142:13435`, `:9477` (`handlePortalAccountAsk`), `packages/domain/120-career-access.js:148-169` (no table, migration or creator) | A3.3, A23.4 seeded | C A | S | MASS (measured: "I never create an account or sign in for you") |
| F23 | "Cloud browser" routes to LinkedIn connect | "Can you apply with the cloud browser only?" gets "I need access to LinkedIn" | `120-career-access.js:461` (keyword), `:361` (LinkedIn default) | A4.2 (both states) | C | S | — |
| F24 | The fabrication refusal is outreach copy | "Do not invent SQL experience on my resume" gets text about shortlists and verified emails | `142:4413`, `:4463,4466` | A6.2 | T | S | PRE (scope) |
| F25 | The prep-eve template states an unsupported claim | "sleep is a scored input tomorrow" | `142:5603` (`handlePrepEve`) | A15.2, live C03 | T | S | PREP (measured: A15.2 delivered in both states) |
| F26 | Practice questions are generic | "Ask one customer support practice question" gets "Tell me about yourself and why this role." | `142:5264-5276`, `packages/domain/127-career-prep.js:405` (`GENERIC_BEHAVIORAL[0]`) | A15.4 (both states) | T | S | PREP (scope) |
| F27 | Counted prep needs a digit and the words "interview questions" | "five questions" is not parsed | `142:5770`, `:5816-5822` (`handlePrepQuestionSet`) | C03, A15.1 | F T | S | PREP (measured: 5 questions in the File) |
| F28 | No prep File, and no prep File kind | The interview prep File the person asked for never exists | `142:5959`, `:6399-6481` (brief only), `_s/file_kinds.ts:17` (`KIND_IDS` has no prep kind) | C03, A15.1 | F | M | PREP (measured: C03 7/7 against Instinct's 6/7, File minted) |
| F29 | Recall reads resume counts, not preferences | "What do you remember about my job preferences?" gets "15 entries — 1 school, 2 jobs …" | `142:15558` | A18.1 seeded | T | S | — |
| F30 | The two search parsers disagree | The router reads one role and count; the search judge re-reads the message and replaces the router reply | `ac/handler-career.ts:1117-1139` (`askFor` → `searchJudgeTurn` overwrite), `142:501` vs `_s/posting_constraints.ts:85` | C01 (router said "customer support", judge said the polluted role) | R | M | — |

### Tier 3: a whole capability is missing or dark at release

| # | title | user-visible symptom | root cause (file:line) | evidence | impact | effort | in flight |
|---|---|---|---|---|---|---|---|
| F31 | No pending-approvals reader | "Show my pending approvals" gets the brain or the catchall | `_s/career_apply_cards.ts:170-174` (only "show prepared applications" matches) | A2.1 | A | S | MASS (measured: A2.1 delivered in both states) |
| F32 | Approving by ordinal reads "second" as an employer | "approve the second application" gets "No application on this card is from "second"" | `_s/career_apply_cards.ts:106` (`PICK_HEAD`), `:123` (`NAME_DESCRIBES` has only first/last), `:152`, `:548` | code read, A2.2 | A | S | MASS (measured: A2.2 delivered; ordinals on a real card not exercised) |
| F33 | No list editing ("skip the first", "drop the third") | The reply shows the first role and offers tailoring | `142:5154-5222` (`handleListReference`), `142:539` (`lastShortlist` only for ordinal apply) | A1.3 seeded | A | S | — |
| F34 | The brain is denied the action tools | Under the staged brain, "apply to these", "set an alert", "stop alerts" and "verify contacts" can't be done by the brain | `ac/career_staged.ts:296` (`STAGED_WITHHELD_TOOLS`) | observed tool list (33 tools, none of these) | A N | M | — |
| F35 | The planner is off: multi-part asks are not split | "find three and send links and don't contact anyone" is one intent | `ac/release_config.ts:138-142` (`CAREER_PLANNER` pending) | C01, C03, C04 | T | M | PRE (scope; measured snapshot does not fix C01, see F59) |
| F36 | No web search: no people discovery and no research | "find alumni at X" / "who is the hiring manager" can only use the person's own exports | `_s/model_gateway.ts:303` (`WEB_SEARCH_AVAILABLE = false`), `_s/career_people_provider.ts:3,102-106` (`not_wired`), `ac/release_config.ts:149-155` (`CAREER_PEOPLE_SEARCH` never on) | A11.x | N | L | — |
| F37 | Warm intros and double opt-in are not wired | A13 asks have no feature behind them | `_s/career_connector.ts:1-22` ("Not wired into handler-career.ts yet (WO-026)", needs `CONNECTOR_ENABLED` and 500 opted-in profiles) | A13 (all brain) | N | L | — |
| F38 | Gmail send is unverified by Google | Outreach and apply-by-email can't send for anyone but Google test users | `ac/release_config.ts:94`, `docs/architect/RELEASE-FLAGS-2026-11-01.md:66` | release note | N C A | L (external) | — |
| F39 | The site says Gmail is read-only, but sending is on | "The permission is read-only: Trainee can't send …" while CAREER_EMAIL_SEND and CAREER_OUTREACH_SEND are on | `site/index.html:1185`, `ac/release_config.ts:97-112` | code read | C T | S | — |
| F40 | Workday and Ashby can't be cloud-submitted | Roles on those portals stop at "site not supported" or a handoff | `workers/career-browser/apply-vm.cjs:39-48` (`atsOf`: Greenhouse and Lever only), `scripts/career/request-verifier.ts:102` (`SCRIPT_FAMILIES`) | code read | A | L | — |
| F41 | The CAPTCHA "handoff ticket" is copy only | "the ticket is minted and the link is yours"; no table persists a ticket, and the real handoff works only in a headed local run | `120-career-access.js:173-191,405-420`, `scripts/apply.ts:349,611-618` | A3.2 | A | M | — |
| F42 | No networking draft without contacts | "Draft a networking email for review only" gets "no one I can write to … download your LinkedIn connections"; Opus drafts with blanks and asks who it is for | `_s/career_networking.ts:607` | A12.1, A12.3 (both states) | N | S | — |
| F43 | Shorten and follow-up work only on a router draft frame, and ignore the word count | "Shorten that answer to 50 words" after a brain draft has nothing to shorten | bundle `router_core.career.js:15237` (shorten regex, ≤7 words), `:24129` (the draft frame is set only for router `*_draft`) | A7.3, A12.2 | T N | M | C04 (measured: A7.1, A7.3, A12.2 now answered by code) |
| F44 | The router gets no conversation history | "What did I actually ask you to do?" / "that is not what I asked" can only use snapshot frames | `_s/career_host.js:35-60` (`STATE_KEYS`); the brain alone gets 40 messages (`ac/career_brain.ts:48`) | A17.2, A17.4 | T | M | — |
| F45 | No data export | "How do I export my data?" has no feature; the only export text is the Upmore archive | no Trainee export flow; root `privacy.html:122` (Upmore) | A22.2 | T | M | — |
| F46 | Account deletion has no Trainee caller | Chat erase clears the career profile but does not delete the account | `_s/account_delete.ts:1-20` (only `extension-sync` calls it), `142:3165-3166` | A22.x | T | M | — |
| F47 | The digest's own stop line may not work | The digest says `Text "weekly digest off" to stop these`, but only the agent tool writes the digest setting | `_s/career_digest.ts:155`, `_s/agent/career_tools.ts:909-925` (`set_weekly_digest`); no router handler | A21.4 | T | S | — |
| F48 | WhatsApp can't message outside the 24 h window; iMessage is unverified | Alerts and digests can't reach WhatsApp users; the iMessage adapter is untested | `ac/release_config.ts:149-155` (`WHATSAPP_TEMPLATE_UPDATES` never on), `_s/loopmessage.ts:1-4`, `docs/architect/RELEASE-NOTE-LIVE-SITE-2026-11-03.md:15,22` | A20.x | T C | L | — |
| F49 | Outlook is coded but not provisioned | People on Outlook can't connect mail | `_s/outlook_graph.ts:27` (`MICROSOFT_OAUTH_*`); `trainee-go-live.sh` never asks for them | code read | C | M (owner) | — |
| F50 | Knowledge is off, so open career questions have no grounded path | "What entry roles should I look at and what training would help?" has no sourced answer | `ac/career_staged.ts:171-187` (`openCareerQuestion` needs `CAREER_KNOWLEDGE`), `ac/release_config.ts:149-155` | C02 (Opus names 6 roles and certificates) | R T | M | — |

### Tier 4: the system makes every fix slower or riskier

| # | title | user-visible symptom | root cause (file:line) | evidence | impact | effort | in flight |
|---|---|---|---|---|---|---|---|
| F51 | Replies read as templates, not texts | Internal words ("company file", "mineable story", "source class"), headers, long walls; "texting" lost 62 of 82 against Opus | about 1,800 sentence literals in the router (ROOT-CAUSES-2026-10-31 §4); router `compose({headline, facts, nextStep})` everywhere | Opus arm, texting dimension | T | L | — |
| F52 | The reply writer is off, and its fact check rejects nearly every rewrite | Live C02/C03: the "rewrite was rejected, template served" | `_s/career_reply_writer.ts:28` (off unless `CAREER_REPLY_WRITER=on`), `:192-216` (any new capitalised word or number rejects), `:233-246` (length ≤ max(280, template)), `:344-345` | live report | T | M | — |
| F53 | One hand-ordered chain decides every turn | 39 `await …Turn(` code-first stages run before router or brain; order is the only arbiter, so a new fix changes other routes | `ac/handler-career.ts:492-927` (code-first chain), `:936-1043` (staged decision last) | ROOT-CAUSES-2026-10-31 §1 | T | L | — |
| F54 | The router is a 16,806-line file with 125 intents and regex dispatch | Every fix here touches one file and the 3 MB bundle; parallel fixes conflict | `packages/domain/142-career-router.js` (16,806 lines), `_s/router_core.career.js` (3.0 MB, generated) | `wc -l`; all 5 in-flight branches edit 142 and the bundle | T | L | — |
| F55 | Eight apply entry points, each re-checking approval | A fix in one path misses the others | ROOT-CAUSES-2026-10-31 §2 (8 SQL paths, 13 functions) | doc | A | L | MASS (partial: the apply ledger) |
| F56 | Every turn commits writes, including read-only asks | "hi" bumps the account version; a concurrent turn gets `revision_conflict` | `supabase/migrations/20261026090009_career_account_memory.sql:97-111` (`career_host_commit`), `:46` | benchmark writes on 208 of 208 turns | T | M (needs a migration, so owner) | — |
| F57 | The model warning names the wrong model | Logs say "MODEL_PROVIDER=openai is ignored … using claude-haiku-5-5" while the brain uses Sonnet 5.5 | `_s/model_gateway.ts:24,32-41` vs `ac/release_model.ts:22-34` | live log | T | S | — |
| F59 | In-flight interaction: PRE lists the wrong roles and takes C02-C04 away from the code that delivers them | On the PRE snapshot, C01 lists 5 "Accounting Assistant … remote: matches your search" roles. C02, C03, C04, A15.1 and A20.2 move to the staged brain, which has no File tool (F07) | `fix/router-constraint-deliverable-prepass` working tree (`157-career-turn-shape.js`, `ac/career_staged.ts`, `ac/handler-career.ts`), snapshot of 2026-11-04 | benchmark on the snapshot: C01 relevant 0/3; 10 records moved to the brain | R F | S | PRE (must be fixed before merge) |
| F58 | Tests and evals can't see brain-turn quality, and most tests assert wording | 60% of beta prompts can't be scored offline; 810 regex-on-reply lines (ROOT-CAUSES §5) | the benchmark's scripted brain; `tests/architect/` | this benchmark | T | M | — |

Public-site content (pricing, security, privacy, terms and support placeholders) is no longer on the live page.
`site/index.html` was rebuilt as an interim page. The placeholders remain in `docs/launch/legal-pages/home.template.html`
(`[YOUR PRICE]` at 649 and 1278-1279, the "Template. Only publish claims that are true" line at 1287, `[DATE]` at 1301
and 1319, `support@example.com` at 545), and `docs/launch/legal-pages/owner-inputs.json` has `LEGAL_NAME`,
`SUPPORT_EMAIL` and `GOVERNING_STATE` set to null. This is an owner input, not engineering work, so it is not ranked.
`site/privacy.html` covers only the browser extension.

## Top 15 in one line each

1. F01: the search role keeps "three realistic … send links do contact anyone", so C01 finds nothing.
2. F02: the search ANDs every word, so one junk word empties it.
3. F05: templates beat the deliverable asked for (File, five questions, timed plan, a direct answer).
4. F04: negated constraints trigger the forbidden route.
5. F06: 126 of 208 turns have no code handler and fall to the brain or a generic text.
6. F07: the brain has no File tool at release.
7. F08: mass apply queues, and nothing executes without the executor and runner secrets.
8. F03: the requested count is ignored ("find 3" lists 8, and then 8 are queued).
9. F10 + F11 + F12: no CPU budget, three router runs and a 600-row map per turn (live C01 died with a 546).
10. F09: the router batch stack and `career_apply_wanted` don't see each other; progress says "no batch".
11. F14 + F15: the counter draft says "the firm", asks for the figure already offered, and never answers "should I".
12. F13: the company-intel gate turns "and" or "Telegram" into a company.
13. F17 + F18: no support or healthcare families, so tailoring binds a software internship.
14. F20: "explain how to delete … without doing it" arms the erase.
15. F51: replies read as templates; texting lost 62 of 82 against Opus.

## Waves: independent work with disjoint files

Rule for every wave: one lane, one PR, and only the files listed. Lanes that edit `142-career-router.js` touch
disjoint functions (line ranges given), so git merges them cleanly. **Each lane regenerates the bundle**
(`python3 scripts/build-router-core.py --career-only`) after rebasing on trunk, and the bundle is never hand-merged.
Every lane adds its prompts to this benchmark's run and must not lower task completion on any other prompt.

### Wave 0: land what is in flight (serial; each edits 142 and the bundle)

Merge in this order, with a bundle rebuild between merges:

1. MASS: the largest measured gain, +11 prompts per state.
2. PREP: C03 and A15.1 fully delivered.
3. C04: C04, A7.1, A7.3 and A12.2.
4. CPU: **merged as #493** while this was written. No deliverable change on the benchmark.
5. PRE last, and only after F59 is fixed. As measured, it hands C03, C04 and A15.1 to the brain and would undo PREP and
   C04. Its C01 change lists unrelated roles.

Then rerun the benchmark and the Opus arm and record the result in `evals/career/SCORE-LOG.md`.

### Wave 1: parallel, no file overlap with each other or with wave 0

| lane | issues | files (only these) |
|---|---|---|
| 1a search | F01, F02, F03 (count parsed in the search judge itself), F30 | `_s/posting_constraints.ts`, `_s/career_search_judge.ts`, `_s/search_correction.ts`, new tests |
| 1b File tool for the brain | F07 | `ac/career_brain.ts` (offer `create_file` when a file store exists, independent of the writer), `_s/agent/file_tool.ts` |
| 1c networking draft | F42 | `_s/career_networking.ts` |
| 1d access copy | F22, F23, F41 | `packages/domain/120-career-access.js` |
| 1e site truth | F39 | `site/index.html` (the Gmail permission line) |
| 1f model log | F57 | `_s/model_gateway.ts` |
| 1g digest stop | F47 | `_s/career_digest.ts` plus a code-first stop in a new `_s/career_digest_chat.ts` (wired in wave 2) |
| 1h approvals reader | F31 | `_s/career_apply_cards.ts` (`parseCardReply` "pending approvals"). This touches the same file as MASS, so start it after MASS merges |

### Wave 2: router lanes (disjoint functions in 142; rebuild the bundle per lane)

| lane | issues | 142 functions (lines on `e6696cb`) |
|---|---|---|
| 2a intel gate | F13 | `:14007` gate, `companyFromText` `:4643-4644`, `handleIntel` `:6627-6727` |
| 2b explain-versus-do | F20, F21 | `handleErasePath` `:3165-3182`, `handleWatchManage` `:11367-11410`, `handleTrackDigest` `:9387-9394` |
| 2c binding | F19, F17 | `handlePacket` `:1186-1203`, tailor dispatch `:13724-13728` |
| 2d list editing and recall | F33, F29 | `handleListReference` `:5154-5222`, recall `:15558` |
| 2e families | F18 | `packages/domain/121-career-jobs.js:88-127` and `INTERVIEW_FAMILIES` `142:5917-5954` (after CPU, which also edits 121) |

### Wave 3: capability and system work (larger; several need the owner)

- **3a.** Batch executor live (F08). This needs the owner: runner secrets and `CAREER_BATCH_EXECUTOR`.
- **3b.** One apply ledger read by status, activity and progress (F09, F55). Files: `_s/career_apply_status.ts` and
  `_s/career_activity.ts`, after MASS.
- **3c.** Give the staged brain the action tools behind the same approval rails (F34). Files: `ac/career_staged.ts`,
  after CPU and PRE.
- **3d.** A deliverable contract (F05, F06, F35). Parse "N / File / plan / draft / for review / answer" once, and make
  every route either meet it or hand it to the brain with the tools to meet it. Builds on PRE's
  `157-career-turn-shape.js`.
- **3e.** Reply voice (F51, F52). A texting writer that is on by default with a fact check that allows words from the
  person's own message. Files: `_s/career_reply_writer.ts`.
- **3f.** Read-only turns don't commit (F56). This is a migration, so owner-approved.
- **3g.** External or owner items: F38 (Google verification), F36 and F50 (web search, knowledge), F37 (intros), F40
  (Workday/Ashby), F48 and F49 (WhatsApp templates, Outlook), F45 and F46 (export, account deletion).

## What the in-flight branches do on this benchmark

The benchmark (`run.ts`, `score.ts`, `cases.json` copied unchanged) was run on each pushed branch head. PRE and C04
were not pushed at the time of writing, so they were not measured. Task completion is strict, as defined above.

Snapshot SHAs:
- CPU `4b02250c`
- MASS `922c64fe`
- PREP `dbbf0e34`
- PRE and C04: the agents' uncommitted working trees on `7aea15ee`, copied into scratch worktrees without being changed

The branch rows below were re-scored from each branch's saved records under the corrected rule (brain records are
never delivered). The branches were not re-run. A branch's replies don't depend on the scoring rule, so a re-run
would give the same records.

| branch | task completion empty | seeded | prompts newly delivered (both states unless marked) | regressions / notes |
|---|---|---|---|---|
| trunk `d3ac642` | 22.1% | 18.3% | (baseline) | |
| #522 search, `d5b952a` (measured with this scoring) | 25.0% | 22.1% | C01 (3 Chicago support roles with links), A1.1 (10), A9.1 (3) in both states; A8.4 seeded | none |
| MASS | **32.7%** | **28.8%** | A2.1, A2.2, A2.3, A3.3, A3.4, A14.4, A23.4, A24.1, A24.2, A24.3, A24.4 (22 records, all moved from the brain to code) | none |
| C04 (snapshot) | 26.0% | 22.1% | C04, A7.1, A7.3, A12.2 | none |
| PREP | 25.0% | 21.2% | C03, A15.1 (File minted, 5 questions, a 30-minute plan), A15.2 | none |
| CPU | 22.1% | 18.3% | none (by design) | none. C01 CPU locally was 281 ms (empty) and 126 ms (seeded), against 428-790 ms on trunk; local CPU is noisy, and the live 546 needs the live isolate to prove |
| PRE (snapshot) | 22.1% | 18.3% | none. C01 now lists 5 roles, all wrong (F59) | C02, C03, C04, A15.1 and A20.2 moved to the brain. C03 and A15.1 there have no File tool |

Combined, the four clean branches (MASS, C04, PREP, CPU) add about 18 prompts per state, about +17 points over trunk.
That estimate assumes no overlap; it holds, because their fixed sets are disjoint. That would put task completion near
40% / 36%, still under half. The largest remaining blocks are:
- F01-F03: search. C01, A1.1 and A9.1 still fail on every branch.
- F06: 51-62 prompts per state still go to the brain and are unverifiable offline.
- F51: voice. Every code reply lost to Opus on "texting".
