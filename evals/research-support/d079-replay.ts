// D-079 (the paid judge measurement of 2026-11-13, $0.0698): its 19 wrong verdicts, as $0 replay data. Each is what judge-measure.ts at
// 2ffb717 sent (the claim and the passage, rebuilt exactly with no network) and the live verdict the run logged (the log keeps verdicts,
// not the judge's raw text). `cause` is the round-9 reading of why it went wrong; tests/architect/pending/research-support-d079-replay-
// 20261113.test.ts replays them against the code with a scripted judge.
// deno-lint-ignore-file

// The question the measure asks each case under: a pay claim under the pay question, any other fact under a neutral one (D-079 asked
// every case the pay question).
export const ASK_OF = (claim: string) => /\$|pay|earn|salary|stipend|bonus|wage|compensation/i.test(claim) ? "what does citadel pay interns" : "what should i know about citadel internships";

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
