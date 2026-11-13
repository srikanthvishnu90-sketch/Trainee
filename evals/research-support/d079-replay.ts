// D-079 (the paid judge measurement of 2026-11-13, $0.0698): its 19 wrong verdicts, as $0 replay data. Each is what judge-measure.ts at
// 2ffb717 sent (the claim and the passage, rebuilt exactly with no network) and the live verdict the run logged (the log keeps verdicts,
// not the judge's raw text). `cause` is the round-9 reading of why it went wrong; tests/architect/pending/research-support-d079-replay-
// 20261113.test.ts replays them against the code with a scripted judge.
// deno-lint-ignore-file

// The question the measure asks each case under: a pay claim under the pay question, any other fact under a neutral one (D-079 asked
// every case the pay question; round 11: run 2 asked the others "about citadel internships", and a fact about full-time hires or
// applications was refused for that).
export const ASK_OF = (claim: string) => /\$|pay|earn|salary|stipend|bonus|wage|compensation/i.test(claim) ? "what does citadel pay interns" : "what should i know about citadel";

export const CAUSES = {
 "harness": "case label wrong (the measure asked every quote whether it answers \"what does citadel pay interns\"; a visa, date or interview fact does not)",
 "prompt": "prompt wording",
 "judge": "judge error on the exact text",
 "passage": "passage missing the evidence",
 "label": "case label wrong (the page does state it)",
 "layerA": "code: layer A let a figure of another noun through"
} as const;

export interface Replay { key: string; cause: keyof typeof CAUSES; live: "yes" | "no"; want: "yes" | "no"; title: string; page: string; claim: string; sentClaim: string; sentPassage: string }
export const D079_WRONG: Replay[] = [
 {
  "key": "true 28: G03 verbatim negative",
  "cause": "harness",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Citadel does not sponsor visas for interns.",
  "claim": "Citadel does not sponsor visas for interns.",
  "sentClaim": "The marked text \"Citadel does not sponsor visas for interns.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Citadel does not sponsor visas for interns. <<<"
 },
 {
  "key": "true 28: G09 range",
  "cause": "prompt",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Citadel interns earn $4,000 to $6,000 a week.",
  "claim": "Citadel interns earn $4,000 to $6,000 a week.",
  "sentClaim": "The marked text \"Citadel interns earn $4,000 to $6,000 a week.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Citadel interns earn $4,000 to $6,000 a week. <<<"
 },
 {
  "key": "true 28: G12 'no' in unrelated clause",
  "cause": "prompt",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Citadel interns earn $5,000 a week, and there is no cap on overtime.",
  "claim": "Citadel interns earn $5,000 a week.",
  "sentClaim": "Citadel interns earn $5,000 a week.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Citadel interns earn $5,000 a week, and there is no cap on overtime. <<<"
 },
 {
  "key": "true 28: G13 'Not only'",
  "cause": "prompt",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Not only do Citadel interns earn $5,000 a week, they also receive housing.",
  "claim": "Citadel interns earn $5,000 a week and receive housing.",
  "sentClaim": "Citadel interns earn $5,000 a week and receive housing.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Not only do Citadel interns earn $5,000 a week, they also receive housing. <<<"
 },
 {
  "key": "true 28: G15 'except' aside",
  "cause": "prompt",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Citadel interns earn $5,000 a week in every office except Dublin.",
  "claim": "Citadel interns earn $5,000 a week in every office except Dublin.",
  "sentClaim": "The marked text \"Citadel interns earn $5,000 a week in every office except Dublin.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Citadel interns earn $5,000 a week in every office except Dublin. <<<"
 },
 {
  "key": "true 28: G16 pct",
  "cause": "harness",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Citadel's headcount grew 12% in 2025.",
  "claim": "Citadel's headcount grew 12% in 2025.",
  "sentClaim": "The marked text \"Citadel's headcount grew 12% in 2025.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Citadel's headcount grew 12% in 2025. <<<"
 },
 {
  "key": "true 28: G17 failed-to word in page",
  "cause": "prompt",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Citadel interns earn $5,000 a week; the firm never fails to pay on time.",
  "claim": "Citadel interns earn $5,000 a week.",
  "sentClaim": "The marked text \"Citadel interns earn $5,000 a week\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Citadel interns earn $5,000 a week <<<\n- the firm never fails to pay on time."
 },
 {
  "key": "true 28: G18 never misses",
  "cause": "prompt",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Citadel has never missed a bonus payment to interns.",
  "claim": "Citadel has always paid bonus payments to interns.",
  "sentClaim": "Citadel has always paid bonus payments to interns.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Citadel has never missed a bonus payment to interns. <<<"
 },
 {
  "key": "true 28: G24 reply no-number true",
  "cause": "harness",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Citadel sponsors visas for interns.",
  "claim": "Citadel sponsors visas for interns.",
  "sentClaim": "The marked text \"Citadel sponsors visas for interns.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Citadel sponsors visas for interns. <<<"
 },
 {
  "key": "true 28: G27 denial page, denial claim",
  "cause": "prompt",
  "live": "no",
  "want": "yes",
  "title": "Citadel compensation notes",
  "page": "Citadel denied that interns earn $9,000 a week.",
  "claim": "Citadel denied that interns earn $9,000 a week.",
  "sentClaim": "The marked text \"Citadel denied that interns earn $9,000 a week.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> Citadel denied that interns earn $9,000 a week. <<<"
 },
 {
  "key": "true 40: Citadel sponsors H-1B visas for full-time hires.",
  "cause": "harness",
  "live": "no",
  "want": "yes",
  "title": "Citadel careers",
  "page": "Citadel sponsors H-1B visas for full-time hires.",
  "claim": "Citadel sponsors H-1B visas for full-time hires.",
  "sentClaim": "The marked text \"Citadel sponsors H-1B visas for full-time hires.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel careers\nWhole page, the candidate marked:\n>>> Citadel sponsors H-1B visas for full-time hires. <<<"
 },
 {
  "key": "true 40: Applications close on January 15, 2027.",
  "cause": "harness",
  "live": "no",
  "want": "yes",
  "title": "Citadel careers",
  "page": "Applications close on January 15, 2027.",
  "claim": "Applications close on January 15, 2027.",
  "sentClaim": "The marked text \"Applications close on January 15, 2027.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel careers\nWhole page, the candidate marked:\n>>> Applications close on January 15, 2027. <<<"
 },
 {
  "key": "true 40: Citadel interviews include 2 technical rounds and 1 behavioral round.",
  "cause": "harness",
  "live": "no",
  "want": "yes",
  "title": "Citadel careers",
  "page": "Citadel interviews include 2 technical rounds and 1 behavioral round.",
  "claim": "Citadel interviews include 2 technical rounds and 1 behavioral round.",
  "sentClaim": "The marked text \"Citadel interviews include 2 technical rounds and 1 behavioral round.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel careers\nWhole page, the candidate marked:\n>>> Citadel interviews include 2 technical rounds and 1 behavioral round. <<<"
 },
 {
  "key": "true 40: Citadel interns are paid $5,000 a week, and housing is provided.",
  "cause": "passage",
  "live": "no",
  "want": "yes",
  "title": "Citadel careers",
  "page": "Citadel interns are paid $5,000/week; housing is provided.",
  "claim": "Citadel interns are paid $5,000 a week, and housing is provided.",
  "sentClaim": "Citadel interns are paid $5,000 a week, and housing is provided.",
  "sentPassage": "Page title: Citadel careers\nWhole page, the candidate marked:\n>>> Citadel interns are paid $5,000/week <<<\n- housing is provided."
 },
 {
  "key": "hostile 94: N17 double negative",
  "cause": "judge",
  "live": "yes",
  "want": "no",
  "title": "Citadel compensation notes",
  "page": "It is not true that Citadel does not sponsor visas for interns.",
  "claim": "Citadel does not sponsor visas for interns.",
  "sentClaim": "Citadel does not sponsor visas for interns.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> It is not true that Citadel does not sponsor visas for interns. <<<"
 },
 {
  "key": "false 101: table: Citadel interns earn $5,000 a month.",
  "cause": "label",
  "live": "yes",
  "want": "no",
  "title": "Citadel notes",
  "page": "Role\tMonthly stipend\nCitadel intern\t$5,000",
  "claim": "Citadel interns earn $5,000 a month.",
  "sentClaim": "Citadel interns earn $5,000 a month.",
  "sentPassage": "Page title: Citadel notes\nTable header: Role | Monthly stipend\nWhole page, the candidate marked:\n- Role | Monthly stipend\n>>> Citadel intern | $5,000 <<<"
 },
 {
  "key": "false 101: table: Citadel accepts 0.5% of applicants.",
  "cause": "label",
  "live": "yes",
  "want": "no",
  "title": "Citadel notes",
  "page": "Company | Offer rate\nCitadel | 0.5%",
  "claim": "Citadel accepts 0.5% of applicants.",
  "sentClaim": "Citadel accepts 0.5% of applicants.",
  "sentPassage": "Page title: Citadel notes\nTable header: Company | Offer rate\nWhole page, the candidate marked:\n- Company | Offer rate\n>>> Citadel | 0.5% <<<"
 },
 {
  "key": "false 101: noun: Citadel pays a $3,000 monthly relocation bonus.",
  "cause": "layerA",
  "live": "yes",
  "want": "no",
  "title": "Citadel notes",
  "page": "Citadel pays a $3,000 monthly housing stipend and a $3,000 relocation bonus.",
  "claim": "Citadel pays a $3,000 monthly relocation bonus.",
  "sentClaim": "Citadel pays a $3,000 monthly relocation bonus.",
  "sentPassage": "Page title: Citadel notes\nWhole page, the candidate marked:\n>>> Citadel pays a $3,000 monthly housing stipend and a $3,000 relocation bonus. <<<"
 },
 {
  "key": "false 101: twice: Citadel cut pay 10% for interns.",
  "cause": "judge",
  "live": "yes",
  "want": "no",
  "title": "Citadel notes",
  "page": "Citadel raised pay 10% for interns and cut pay 10% for contractors.",
  "claim": "Citadel cut pay 10% for interns.",
  "sentClaim": "Citadel cut pay 10% for interns.",
  "sentPassage": "Page title: Citadel notes\nWhole page, the candidate marked:\n>>> Citadel raised pay 10% for interns and cut pay 10% for contractors. <<<"
 }
];

// Run 2 (D-080, 2026-11-13, $0.116, ffaa69332): its 10 wrong verdicts, rebuilt exactly at the run's code with no network (the log keeps
// verdicts, not the judge's text). `why` is the round-11 reading; tests/architect/pending/research-support-d079-replay-20261113.test.ts
// replays them.
export interface Replay2 extends Replay { why: string }
export const RUN2_WRONG: Replay2[] = [
 {
  "key": "true 28: G19 without attribution owner",
  "cause": "label",
  "live": "no",
  "want": "yes",
  "why": "The claim adds \"According to the careers page\"; the page is titled \"Citadel compensation notes\" and says nothing of a careers page. The judge was right; the label is wrong.",
  "title": "Citadel compensation notes",
  "page": "The summer program at Citadel runs for eleven weeks in Chicago.",
  "claim": "According to the careers page, the summer program at Citadel runs for eleven weeks in Chicago.",
  "sentClaim": "According to the careers page, the summer program at Citadel runs for eleven weeks in Chicago.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n>>> The summer program at Citadel runs for eleven weeks in Chicago. <<<"
 },
 {
  "key": "true 28: G20 quote ends with stop",
  "cause": "label",
  "live": "yes",
  "want": "no",
  "why": "\"Citadel has 2,800 employees. It was founded in 1990.\" does say Citadel was founded in 1990 (\"It\" is Citadel). The judge was right; the label is wrong.",
  "title": "Citadel compensation notes",
  "page": "Citadel has 2,800 employees. It was founded in 1990.",
  "claim": "Citadel was founded in 1990.",
  "sentClaim": "Citadel was founded in 1990.",
  "sentPassage": "Page title: Citadel compensation notes\nWhole page, the candidate marked:\n- Citadel has 2,800 employees.\n>>> It was founded in 1990. <<<"
 },
 {
  "key": "false 101: heading: Citadel pays interns $5,000 weekly.",
  "cause": "layerA",
  "live": "yes",
  "want": "no",
  "why": "The page is the label \"Citadel: $5,000 weekly\": the claim adds \"interns\". Code: a role the claim names must be in what the judge is shown.",
  "title": "Citadel notes",
  "page": "Citadel: $5,000 weekly",
  "claim": "Citadel pays interns $5,000 weekly.",
  "sentClaim": "Citadel pays interns $5,000 weekly.",
  "sentPassage": "Page title: Citadel notes\nWhole page, the candidate marked:\n>>> Citadel: $5,000 weekly <<<"
 },
 {
  "key": "false 101: time: Applications at Citadel close on March 3.",
  "cause": "prompt",
  "live": "yes",
  "want": "no",
  "why": "\"closed\" (past) taken for \"close\": prompt now says tense is part of the fact.",
  "title": "Citadel notes",
  "page": "Applications at Citadel closed on March 3.",
  "claim": "Applications at Citadel close on March 3.",
  "sentClaim": "Applications at Citadel close on March 3.",
  "sentPassage": "Page title: Citadel notes\nWhole page, the candidate marked:\n>>> Applications at Citadel closed on March 3. <<<"
 },
 {
  "key": "true 40: Citadel interns earn $5,000 a week.",
  "cause": "passage",
  "live": "no",
  "want": "yes",
  "why": "\"Our interns earn $5,000 a week.\" on \"Citadel careers\": nothing in the passage said whose \"our\" it is. Code now adds \"Page of: Citadel (...)\"; the prompt reads we/our on it as Citadel.",
  "title": "Citadel careers",
  "page": "Our interns earn $5,000 a week.",
  "claim": "Citadel interns earn $5,000 a week.",
  "sentClaim": "Citadel interns earn $5,000 a week.",
  "sentPassage": "Page title: Citadel careers\nWhole page, the candidate marked:\n>>> Our interns earn $5,000 a week. <<<"
 },
 {
  "key": "true 40: Citadel pays interns $5,000 a week.",
  "cause": "passage",
  "live": "no",
  "want": "yes",
  "why": "\"We pay interns $5,000 a week.\": as above.",
  "title": "Citadel careers",
  "page": "Software Engineering Intern\nWe pay interns $5,000 a week.",
  "claim": "Citadel pays interns $5,000 a week.",
  "sentClaim": "Citadel pays interns $5,000 a week.",
  "sentPassage": "Page title: Citadel careers\nWhole page, the candidate marked:\n- Software Engineering Intern\n>>> We pay interns $5,000 a week. <<<"
 },
 {
  "key": "true 40: Citadel software interns earn a median of $120 per hour.",
  "cause": "prompt",
  "live": "no",
  "want": "yes",
  "why": "\"The median Citadel software intern salary is $120 an hour.\": a paraphrase; the prompt now has it as an example.",
  "title": "Levels: Citadel intern pay",
  "page": "The median Citadel software intern salary is $120 an hour.",
  "claim": "Citadel software interns earn a median of $120 per hour.",
  "sentClaim": "Citadel software interns earn a median of $120 per hour.",
  "sentPassage": "Page title: Levels: Citadel intern pay\nWhole page, the candidate marked:\n>>> The median Citadel software intern salary is $120 an hour. <<<"
 },
 {
  "key": "true 40: Citadel sponsors H-1B visas for full-time hires.",
  "cause": "harness",
  "live": "no",
  "want": "yes",
  "why": "Asked whether it answers \"what should i know about citadel internships\" (a fact about full-time hires). The measure now asks \"what should i know about citadel\".",
  "title": "Citadel careers",
  "page": "Citadel sponsors H-1B visas for full-time hires.",
  "claim": "Citadel sponsors H-1B visas for full-time hires.",
  "sentClaim": "The marked text \"Citadel sponsors H-1B visas for full-time hires.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what should i know about citadel internships.",
  "sentPassage": "Page title: Citadel careers\nWhole page, the candidate marked:\n>>> Citadel sponsors H-1B visas for full-time hires. <<<"
 },
 {
  "key": "true 40: Applications close on January 15, 2027.",
  "cause": "harness",
  "live": "no",
  "want": "yes",
  "why": "No subject on the page and the same internships question; now the neutral question and the \"Page of:\" line.",
  "title": "Citadel careers",
  "page": "Applications close on January 15, 2027.",
  "claim": "Applications close on January 15, 2027.",
  "sentClaim": "The marked text \"Applications close on January 15, 2027.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what should i know about citadel internships.",
  "sentPassage": "Page title: Citadel careers\nWhole page, the candidate marked:\n>>> Applications close on January 15, 2027. <<<"
 },
 {
  "key": "true 40: The pay range is $4,000 to $5,000 a week.",
  "cause": "passage",
  "live": "no",
  "want": "yes",
  "why": "\"Pay range: $4,000 - $5,000 a week.\" with no subject and a dash: now the \"Page of:\" line, and the prompt reads a dash range as \"to\".",
  "title": "Citadel careers",
  "page": "Pay range: $4,000 - $5,000 a week. Location: Chicago, IL.",
  "claim": "The pay range is $4,000 to $5,000 a week.",
  "sentClaim": "The pay range is $4,000 to $5,000 a week.",
  "sentPassage": "Page title: Citadel careers\nWhole page, the candidate marked:\n>>> Pay range: $4,000 - $5,000 a week. <<<\n- Location: Chicago, IL."
 }
];

// Run 3 (D-082, 2026-11-13, $0.129, 74d66a1cb): its 10 wrong verdicts, rebuilt exactly at the run's code with no network.
export const RUN3_WRONG: Replay2[] = [
 {
  "key": "hostile 94: N17 double negative",
  "cause": "judge",
  "live": "yes",
  "want": "no",
  "why": "\"It is not true that Citadel does not sponsor visas\" read as a denial; the prompt has had the double-negation rule since round 9, and the judge still erred. Needs the judge.",
  "title": "Citadel compensation notes",
  "page": "It is not true that Citadel does not sponsor visas for interns.",
  "claim": "Citadel does not sponsor visas for interns.",
  "sentClaim": "Citadel does not sponsor visas for interns.",
  "sentPassage": "Page title: Citadel compensation notes\nPage of: Citadel (the page title names only it)\nWhole page, the candidate marked:\n>>> It is not true that Citadel does not sponsor visas for interns. <<<"
 },
 {
  "key": "true 28: G01 verbatim",
  "cause": "judge",
  "live": "no",
  "want": "yes",
  "why": "The passage is clean and holds the fact word for word or in plain paraphrase; the judge refused it. Judge noise: needs the judge (no code cause found).",
  "title": "Citadel compensation notes",
  "page": "Citadel interns earn $5,000 a week.",
  "claim": "Citadel interns earn $5,000 a week.",
  "sentClaim": "The marked text \"Citadel interns earn $5,000 a week.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what does citadel pay interns.",
  "sentPassage": "Page title: Citadel compensation notes\nPage of: Citadel (the page title names only it)\nWhole page, the candidate marked:\n>>> Citadel interns earn $5,000 a week. <<<"
 },
 {
  "key": "true 28: G19 without attribution owner",
  "cause": "label",
  "live": "no",
  "want": "yes",
  "why": "The claim adds \"According to the careers page\": the judge is right (as in run 2).",
  "title": "Citadel compensation notes",
  "page": "The summer program at Citadel runs for eleven weeks in Chicago.",
  "claim": "According to the careers page, the summer program at Citadel runs for eleven weeks in Chicago.",
  "sentClaim": "According to the careers page, the summer program at Citadel runs for eleven weeks in Chicago.",
  "sentPassage": "Page title: Citadel compensation notes\nPage of: Citadel (the page title names only it)\nWhole page, the candidate marked:\n>>> The summer program at Citadel runs for eleven weeks in Chicago. <<<"
 },
 {
  "key": "false 101: table: Citadel interns earn $5,000 a month.",
  "cause": "label",
  "live": "yes",
  "want": "no",
  "why": "Header \"Monthly stipend\" over \"Citadel intern | $5,000\": the page does state it (as in D-079).",
  "title": "Citadel notes",
  "page": "Role\tMonthly stipend\nCitadel intern\t$5,000",
  "claim": "Citadel interns earn $5,000 a month.",
  "sentClaim": "Citadel interns earn $5,000 a month.",
  "sentPassage": "Page title: Citadel notes\nPage of: Citadel (the page title names only it)\nTable header: Role | Monthly stipend\nWhole page, the candidate marked:\n- Role | Monthly stipend\n>>> Citadel intern | $5,000 <<<"
 },
 {
  "key": "false 101: heading: Citadel intern pay is $5,000 a week.",
  "cause": "layerA",
  "live": "yes",
  "want": "no",
  "why": "\"Citadel intern pay 2019: $5,000 a week\": a past year read as a bare number. Code: a bare past year on the unit is one the claim must carry.",
  "title": "Citadel notes",
  "page": "Citadel intern pay 2019: $5,000 a week",
  "claim": "Citadel intern pay is $5,000 a week.",
  "sentClaim": "Citadel intern pay is $5,000 a week.",
  "sentPassage": "Page title: Citadel notes\nPage of: Citadel (the page title names only it)\nWhole page, the candidate marked:\n>>> Citadel intern pay 2019: $5,000 a week <<<"
 },
 {
  "key": "false 101: entity: Citadel interns earn $5,000 a week.",
  "cause": "prompt",
  "live": "yes",
  "want": "no",
  "why": "\"A Citadel intern earned $5,000 a week.\": one person's case read as all interns. Prompt rule added.",
  "title": "Citadel notes",
  "page": "A Citadel intern earned $5,000 a week.",
  "claim": "Citadel interns earn $5,000 a week.",
  "sentClaim": "Citadel interns earn $5,000 a week.",
  "sentPassage": "Page title: Citadel notes\nPage of: Citadel (the page title names only it)\nWhole page, the candidate marked:\n>>> A Citadel intern earned $5,000 a week. <<<"
 },
 {
  "key": "true 40: Applications close on January 15, 2027.",
  "cause": "judge",
  "live": "no",
  "want": "yes",
  "why": "The passage is clean and holds the fact word for word or in plain paraphrase; the judge refused it. Judge noise: needs the judge (no code cause found).",
  "title": "Citadel careers",
  "page": "Applications close on January 15, 2027.",
  "claim": "Applications close on January 15, 2027.",
  "sentClaim": "The marked text \"Applications close on January 15, 2027.\" is the page's own statement of fact about Citadel specifically, not about another firm, not an instruction, an offer or a request to the reader, and it answers the question: what should i know about citadel.",
  "sentPassage": "Page title: Citadel careers\nPage of: Citadel (the page title names only it)\nWhole page, the candidate marked:\n>>> Applications close on January 15, 2027. <<<"
 },
 {
  "key": "true 40: Citadel reportedly raised intern pay to $5,000 a week in 2025.",
  "cause": "judge",
  "live": "no",
  "want": "yes",
  "why": "The passage is clean and holds the fact word for word or in plain paraphrase; the judge refused it. Judge noise: needs the judge (no code cause found).",
  "title": "Bloomberg",
  "page": "Citadel raised intern pay to $5,000 a week in 2025, according to people familiar with the matter.",
  "claim": "Citadel reportedly raised intern pay to $5,000 a week in 2025.",
  "sentClaim": "Citadel reportedly raised intern pay to $5,000 a week in 2025.",
  "sentPassage": "Page title: Bloomberg\nWhole page, the candidate marked:\n>>> Citadel raised intern pay to $5,000 a week in 2025, according to people familiar with the matter. <<<"
 },
 {
  "key": "true 40: Returning interns get a $10,000 signing bonus.",
  "cause": "judge",
  "live": "no",
  "want": "yes",
  "why": "The passage is clean and holds the fact word for word or in plain paraphrase; the judge refused it. Judge noise: needs the judge (no code cause found).",
  "title": "Citadel careers",
  "page": "The firm offers a signing bonus of $10,000 to returning interns.",
  "claim": "Returning interns get a $10,000 signing bonus.",
  "sentClaim": "Returning interns get a $10,000 signing bonus.",
  "sentPassage": "Page title: Citadel careers\nPage of: Citadel (the page title names only it)\nWhole page, the candidate marked:\n>>> The firm offers a signing bonus of $10,000 to returning interns. <<<"
 },
 {
  "key": "true 40: Citadel gives returning interns a $10,000 signing bonus.",
  "cause": "judge",
  "live": "no",
  "want": "yes",
  "why": "The passage is clean and holds the fact word for word or in plain paraphrase; the judge refused it. Judge noise: needs the judge (no code cause found).",
  "title": "Citadel careers",
  "page": "Citadel offers a signing bonus of $10,000 to returning interns.",
  "claim": "Citadel gives returning interns a $10,000 signing bonus.",
  "sentClaim": "Citadel gives returning interns a $10,000 signing bonus.",
  "sentPassage": "Page title: Citadel careers\nPage of: Citadel (the page title names only it)\nWhole page, the candidate marked:\n>>> Citadel offers a signing bonus of $10,000 to returning interns. <<<"
 }
];
