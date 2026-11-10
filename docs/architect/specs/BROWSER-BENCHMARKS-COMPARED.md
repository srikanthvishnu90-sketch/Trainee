# Public web-agent benchmarks, compared with our strict benchmark (b-public-bench, 2026-11-10)

Why this exists: the strict benchmark sits at 37 of 220 real postings on run 6 (CI run 42719264485, per the agent brief).
People will hold that number up against "WebVoyager 97%" or "Online-Mind2Web 90%". This page says what those numbers
measure, how each is judged, and why they do not compare with ours.

## How the sources were read (read this before quoting a number)

This sandbox cannot reach arxiv.org, huggingface.co, the steel.dev site or any vendor site (DNS failures and proxy
refusals, 2026-11-10). It can reach GitHub. So every number here carries one of three tags:

- **[R]** read in this session from the benchmark authors' own GitHub repository, or a leaderboard repository on GitHub.
  The file is linked.
- **[S]** taken from a web-search summary of the cited paper or page. The paper itself was not opened here. Re-check it
  against the PDF before putting it in a release note.
- **[V]** a vendor's own claim, unaudited, quoted from a search summary of the vendor's page or a third-party review.

Leaderboard rows are snapshots of `steel-dev/leaderboard` README on 2026-11-10 ([R], https://github.com/steel-dev/leaderboard).
Most rows there are self-reported by whoever built the agent. That README says so itself: "Treat anything self-reported
with the appropriate dose of skepticism."

## Our strict benchmark (what everything below is compared against)

Defined in `scripts/browser-eval/strict.cjs` (branch `bench/browser-strict5`):

- **Agent:** the production runner (`workers/career-browser/parallel-apply.cjs` `applyOne`), not a separate eval path.
- **Task:** one real, live job posting on an ATS (Greenhouse, Lever, Ashby, SmartRecruiters, Workable and others), with a
  synthetic test person and resume and no answers to custom questions.
- **Pass:** the runner reaches the instant before its Submit click with the page on an allowed host, no shown check or
  sign-in wall, the form found, every filled field read back, nothing required left empty, the form posting to an
  allowed host, and the payload hash still matching. "Ready if answered" is reported beside PASS and is not a pass.
- **Judge:** deterministic code. No LLM judge and no human grading.
- **Denominator:** every sampled posting (220), including closed, unreachable and robots-refused ones. No task is removed
  for being impossible.
- **Safety:** nothing is sent. Non-GET requests are aborted (GraphQL reads excepted), form submits are cancelled, the
  runner is stopped before its click, and robots.txt is obeyed.
- **Score:** 14, 14, 15, 15, 35, 37 of 220 across six runs; run 6 is CI 42719264485 (agent brief, 2026-11-10).

## Summary table

| Benchmark | Sites | Tasks | Judged by | Top published score (source, tag) | Closest to us? |
|---|---|---|---|---|---|
| WebArena | 4 self-hosted sandbox site types (shop, forum, GitLab, CMS, plus map and wiki) | 812 | programmatic checks on answer or site state | 74.3% WebTactix, self-reported (steel, [R]); paper: GPT-4 14.41%, human 78.24% ([S]) | no: sandbox, mostly read tasks |
| VisualWebArena | 3 self-hosted sites (classifieds, shopping, reddit) | 910 | execution-based checks, as WebArena | human ~89% ([R]); paper best GPT-4o 19.78% ([S]); later methods ~54% ([S], aggregator) | no |
| Mind2Web | cached snapshots of real sites | see paper (not read here) | offline: each step compared with a recorded human step | task SR 5.2% Flan-T5-XL Cross-Task ([S]) | no: offline, no live page |
| Online-Mind2Web | 136 live sites | 300 | human evaluation; WebJudge LLM judge for auto-eval | 97.0% Browser Use Cloud, self-reported (steel, [R]); paper: Operator 61.3% by human eval ([S]) | partly: live sites |
| WebVoyager | 15 live sites | 643 | GPT-4V judge on final screenshots and answer, or humans | 99.19% browser-control (Fable 5), self-reported (steel, [R]); paper 59.1% ([R] via Magnitude) | partly: live sites, read tasks |
| WorkArena (L1) / WorkArena++ | 1 ServiceNow instance | 33 tasks, 19,912 instances ([S]); 682 L2+L3 tasks ([R]) | validation functions on platform state | L1: GPT-4o 42.7% ([S]); L2: GPT-4o 3.0% ([S]); L3: 0 ([S]) | partly: enterprise forms |
| FormFactory | 40+ self-hosted HTML forms, 8 domains | form-fill episodes | field values compared with gold answers | click success under 10%, full form under 2% zero-shot ([S]) | yes on task, no on realism |
| ClawBench | 163 live sites | 281 (V1 152, V2 129), includes job applications | final HTTP request intercepted and matched, then an LLM judge | V2: Claude Opus 4.7 54.6% intercepted, 44.6% lenient, 24.6% strict ([R]); V1: Claude Sonnet 4.6 33.3% ([R]) | closest: live write tasks, final request blocked |

## Each benchmark

### WebArena
- **Task:** natural-language tasks on self-hosted copies of an e-commerce site, a forum, GitLab and a CMS, plus map and
  wiki tools. 812 tasks: README "After evaluating the 812 examples" ([R], https://github.com/web-arena-x/webarena).
- **Success:** functional checks on the returned answer or on site state after the run (exact match, must-include, LLM
  fuzzy match, programmatic state checks), from the paper ([S], https://arxiv.org/abs/2307.13854).
- **Scores:** paper, best GPT-4 agent 14.41% end-to-end, humans 78.24% ([S], https://arxiv.org/abs/2307.13854,
  ICLR 2024). Leaderboard top 5 ([R], steel README): WebTactix (DeepSeek v3.2) 74.3%; OpAgent 71.6%;
  ColorBrowserAgent 71.2%; Claude Code + GBOX MCP 68.0%; DeepSky Agent 66.9%. The official leaderboard is a Google
  Sheet linked from the WebArena README ([R]).
- **Unlike ours:** sandbox sites that never change, carry no bot checks and have no closed pages; every task is solvable
  by construction; most tasks are retrieval or a single edit, not a long form; the denominator is a fixed curated set.

### VisualWebArena
- **Task:** visually grounded tasks on self-hosted classifieds, shopping and reddit sites; 910 tasks ([R],
  https://github.com/web-arena-x/visualwebarena: "the full set of 910 VWA tasks").
- **Success:** "the reproducible, execution based evaluation introduced in WebArena" ([R], README).
- **Scores:** human success "~89%" on 233 tasks ([R], README). Paper best GPT-4o 19.78% ([S],
  https://arxiv.org/abs/2401.13649, ACL 2024). Aggregators list later methods at about 54 (SGV) and 52.9 (WALT) ([S],
  wizwand.com aggregator; not checked against the papers).
- **Unlike ours:** same as WebArena: sandbox, solvable by construction, no write to a real third party.

### Mind2Web
- **Task:** tasks on real websites recorded once as human action sequences with page snapshots ([R],
  https://github.com/OSU-NLP-Group/Mind2Web: "raw dump with full traces and snapshots"). Task and site counts are in
  the paper (https://arxiv.org/abs/2306.06070), not read here.
- **Success:** offline. Element accuracy, operation F1, step success rate (right element and right operation at each
  step, against the gold trace), and task success (every step right) ([S], search summary of the paper).
- **Scores:** MindAct Flan-T5-XL Cross-Task: 55.1% element accuracy, 52.0% step SR, 5.2% task SR; Cross-Website 42.0% /
  38.9% step SR ([S], paper via search summary, NeurIPS 2023).
- **Unlike ours:** nothing runs on a live page; a step is "right" if it matches what a human once did, so a different
  valid path counts as wrong and a dead page cannot happen.

### Online-Mind2Web
- **Task:** "300 diverse tasks from 136 popular websites" run live ([R], https://github.com/OSU-NLP-Group/Online-Mind2Web).
  36 tasks were replaced on 2025-11-03 because they were "no longer valid or involve websites with CAPTCHA
  verification" ([R], same README), and more on later dates through 2026-05-15 ([R]).
- **Success:** human evaluation of the trajectory; WebJudge (an LLM judge) for automatic evaluation. Agreement of the
  o4-mini WebJudge with humans averaged 85.7% across six agents; the GPT-6 Luna backbone 87.4% ([R], README table). An
  outside check on 106 Fara-7B trajectories put WebJudge (o4-mini) at 72.0% agreement with a 30.0% false-positive rate
  ([R], README, citing CUAVerifierBench https://arxiv.org/abs/2604.06240).
- **Scores:** paper (COLM 2025): OpenAI Operator 61.3% by human evaluation, most agents near 30% ([S],
  https://arxiv.org/abs/2504.01382). Leaderboard top 5 ([R], steel README): Browser Use Cloud (bu-max) 97.0%; GPT-5.4
  Native Computer Use 93.0%; ABP + Claude Opus 4.6 90.53%; TinyFish 90.0%; CUAWright + GPT-5.5 89.4%. The authors' own
  leaderboard is on Hugging Face (not reachable here).
- **Unlike ours:** live sites, which is close; but tasks with captchas or dead pages are replaced rather than counted as
  failures, the judge is an LLM or a person reading the trajectory, and most tasks are search-and-report, not a long
  write form.

### WebVoyager
- **Task:** "643 task queries, covering 15 websites" (Amazon, Booking, Google Flights and others), live ([R],
  https://github.com/MinorJerry/WebVoyager). Time-sensitive tasks need their dates updated by hand before each run ([R]).
- **Success:** humans reading screenshots, or a GPT-4V judge given "the task, the responses from WebVoyager, and the last
  k screenshots" ([R], README).
- **Scores:** original WebVoyager agent 59.1% ([R], table in https://github.com/magnitudedev/webvoyager). Magnitude
  93.9%, "554/590", after "patches to update dates on several tasks, and remove a few impossible tasks", LLM-judged with
  "some false positives as well as false negatives" ([R], same README). Browser Use 89.1%, OpenAI Operator 87.0%, Skyvern
  85.9% ([R], same table, self-reported by each). Leaderboard top ([R], steel README): browser-control (Fable 5) 99.19%;
  Alumnium 98.5%; Surfer 2 97.1%; Magnitude 93.9%; Surfer-H + Holo1 92.2%.
- **Reproduction gap:** Notte re-ran Browser Use on a 30-task subset, 8 runs each, and measured 77.3% self-reported and
  60.2% LLM-verified success, against the 89% Browser Use published; "Their results files are not available for
  verification" ([R], https://github.com/nottelabs/open-operator-evals).
- **Unlike ours:** the denominator shrinks (impossible tasks removed), the judge is an LLM looking at screenshots, the
  agent's own answer is what is graded, and the tasks are read-only lookups. The 59% to 99% climb is partly a cleaner
  task set, not only better agents.

### WorkArena and WorkArena++
- **Task:** knowledge-work tasks on a ServiceNow instance: forms, lists, catalogs, dashboards. L1: 33 task templates;
  L2 and L3: 341 each ([R], https://github.com/ServiceNow/AgentLab table). L1 has 19,912 instances ([S],
  https://arxiv.org/abs/2403.07718, ICML 2024).
- **Success:** validation functions that read the platform's state after the run ([S], paper).
- **Scores:** L1, GPT-4o 42.7%; list-filter tasks 0% for every model ([S], https://arxiv.org/abs/2403.07718 via search
  summary). WorkArena++ (NeurIPS 2024): no agent completed any L3 task; L2 GPT-4o 3.0%, GPT-4o-vision 3.8%; humans 93.9%
  ([S], https://arxiv.org/abs/2407.05291 via search summary; one blog gives 2.1% for GPT-4o, so check the PDF).
- **Unlike ours:** one known platform with a stable DOM, solvable by construction, judged by reading the database; closer
  in spirit (form filling with checked state) but with none of the variety of 11 ATS providers.

### FormFactory (form filling)
- **Task:** fill web forms from a source document such as a resume. "40+ high-fidelity HTML forms from real-world
  scenarios spanning eight domains" ([R], https://github.com/formfactory-ai/FormFactory); the paper says 25 forms and
  13,800 field-value annotations ([S], https://arxiv.org/abs/2506.01520, June 2025).
- **Success:** submitted values compared with gold answers: field-level and form-level accuracy ([R], README).
- **Scores:** zero-shot, click success under 10% and full-form completion under 2% ([S], paper via search summary).
- **Unlike ours:** the task matches (fill a form from a person's facts, all fields right) but the forms are local copies,
  no live page, no upload widget variety, no bot checks.
- Related: FormGym (June 2025), 432 fields over 55 documents, image-only paperwork ([S], https://arxiv.org/abs/2506.14079).

### ClawBench (the closest public benchmark)
- **Task:** everyday write tasks on live production sites, "booking travel, ordering food, applying for jobs, managing
  email". V1 152 tasks on 143 sites, V2 129 tasks on 63 sites, 281 tasks on 163 sites in all ([R],
  https://github.com/reacher-z/ClawBench). Findings of EMNLP 2026 ([R]).
- **Success:** two stages. Stage 1, deterministic: the final HTTP request is intercepted and must match the task's URL
  and method ("Intercepted"). Stage 2: an LLM judge (deepseek-v4-pro) checks the request fulfils the instruction, under a
  lenient or a strict rubric ([R], README). Two runs of the same model reproduce within ±2 pp ([R]).
- **Scores, V2 Hermes harness ([R], README):** claude-opus-4-7 54.6% intercepted, 44.6% lenient, 24.6% strict (58/130);
  gpt-5.5 45.4% / 35.4% / 18.5%; glm-5.1 48.5% / 34.6% / 17.7%. V1 paper results, trajectory evaluation: Claude Sonnet
  4.6 33.3%, GLM-5 24.2%, Gemini 3 Flash 19.0%, GPT-5.4 6.5% ([R]). The paper notes the same models score 65-75% on
  OSWorld and WebArena ([S], https://arxiv.org/abs/2604.08523).
- **Unlike ours:** the method is the same idea (live site, block the final write, grade what would have been sent), and
  its strict score for the best model (24.6%) sits near our 37/220 (16.8%). Differences: a general agent and an LLM
  judge, not a production runner and code checks; tasks were filtered to remove paid, geo-restricted and dead sites
  ([S]); job applications are one category among 15, not the whole set.

## Commercial job-apply agents: what they publish

None of the four publishes a benchmark: no task set, no denominator, no definition of "applied". Everything below is a
vendor claim or a third-party anecdote.

| Product | What it claims | Success measure published? |
|---|---|---|
| Simplify (Copilot autofill extension) | "200,000,000+ applications submitted" on its homepage; older pages say 30 million and 100 million; autofill on "over 100 job boards and application portals" ([V], https://simplify.jobs, https://simplify.jobs/copilot via search summary) | No. A review notes it "may miss fields, misinterpret labels" ([S], search summary). |
| AIApply | "372,241+ roles applied to"; "80% more likely to get a job faster", called methodology-free by a comparison site ([V], https://aiapply.co via search summary) | No interview or completion rate. |
| LazyApply | No official rate found. Third parties: a Business Insider test cited by a competitor, 7 responses from 126 applications (6%); other blogs give 0.4-2% callbacks ([S], https://scale.jobs/blog/is-lazyapply-worth-trying-scale-jobs-outperforms, a competitor) | No. |
| Tsenta | Features, not outcomes; one user quoted with "more than 25 interviews in three weeks" ([V], https://yourstory.com/2026/06/tsenta-wants-to-make-job-applications-faster-smarter-less-manual); every change shown to the user before it goes out ([V], https://www.tsenta.com/ai-disclosure) | No. |

The counted unit is "applications submitted" or "roles applied to", with no statement of how many attempts failed,
stalled on a field, or were handed back. A count with no denominator cannot be compared with a rate. Callback rates
(0.4-6%) measure the employer's response, which is downstream of submission and depends on fit, not the agent's fill.

## What this means for us

1. **No public number is comparable with 37/220.** Every public web benchmark either uses sandbox sites, removes
   impossible tasks, grades with an LLM or a human reading the trajectory, or grades read-only answers. Ours keeps every
   sampled posting in the denominator, grades with code, and requires every filled field read back.
2. **ClawBench is the one to cite beside ours.** It also blocks the final write on live sites and grades the request,
   and its strict rubric gives the best model 24.6% (58 of 130 judged). Running our runner on its job-application tasks
   (if their terms allow) would give the one outside comparison that means something.
3. **Report ours in two lines, the way ClawBench does:** strict pass over every sampled posting, and pass over postings
   that were open and reachable. The second number is the one closest in spirit to the public benchmarks that drop
   dead tasks; the first stays the bar.
4. **Vendor counts are not evidence.** No job-apply vendor publishes a denominator; we should not quote theirs and should
   not publish ours without one.

## To re-check before quoting outside the team

Every [S] number above. They need the PDFs: WebArena 14.41% / 78.24%; VisualWebArena 19.78%; Mind2Web 5.2% / 52.0%;
Online-Mind2Web Operator 61.3%; WorkArena 42.7%, WorkArena++ 3.0% / 93.9%; FormFactory under 10% / under 2%.
