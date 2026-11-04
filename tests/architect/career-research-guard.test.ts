// Probes for the source guard (PR #277 review): spelled-out numbers, lowercase names, numbers matched to the wrong subject.
//   deno test -A --no-check tests/architect/career-research-guard.test.ts
import assertNode from "node:assert/strict";
import { acceptFacts, unsourcedIn, unsupported } from "../../supabase/functions/_shared/agent/research/guard.ts";
import { lintChat } from "../../supabase/functions/_shared/agent/research/chat.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const URL_ = "https://a.example/x";
const accepts = (text: string, quote: string) => acceptFacts([{ id: "", kind: "pay", text, quote, url: URL_, label: "a.example" }], [URL_]).kept.length === 1;
const flagged = (line: string, support: string[] = [], person: string[] = [], message = "") =>
  unsourcedIn(line, { facts: support.map((s) => ({ id: "", kind: "pay" as const, text: s, quote: s, url: URL_, label: "a.example" })), person, message });

// [text, quote, accepted?]
const FACTS: [string, string, boolean][] = [
  ["Median pay is seventy thousand dollars.", "Nurses work long shifts and many enjoy the work.", false],
  ["Median pay is seventy thousand dollars.", "The median annual pay for nurses is $70,000 in the most recent year.", true],
  ["Median pay is $70k.", "The median annual pay is seventy thousand dollars.", true],
  ["Ninety percent of graduates are hired within a year of finishing.", "Placement data: 90% of graduates are hired within a year of finishing.", true],
  ["Employment of nurses will grow 9 percent over the decade.", "Employment of nurses is projected to grow nine percent over the decade.", true],
  ["Employment of nurses will grow 6 percent over the decade.", "Pay was $86,070, and 6 percent of nurses work night shifts only.", false],
  ["Pay ranges from 50 to 60 thousand dollars.", "Typical pay ranges from $50,000 to $60,000 a year.", true],
  ["Half of hires come through referrals.", "About half of hires come through employee referrals.", true],
  ["Half of hires come through referrals.", "Hires come through postings and referrals.", false],
  ["amazon hires many new graduates every year.", "Large employers hire new graduates every year.", false],
  ["Amazon hires many new graduates every year.", "Large employers hire new graduates every year.", false],
  ["Candidates go through a fourth round of interviews.", "Candidates go through three rounds of interviews.", false],
  ["The field has 1.2 million jobs.", "The field has 1,200,000 jobs across the country.", true],
  ["Twenty-five percent of apprentices finish early.", "25 percent of apprentices finish early, the report says.", true],
  ["Twenty-five percent of apprentices finish early.", "52 percent of apprentices finish early, the report says.", false],
  ["Nearly one in three applicants receive an offer.", "Applicants receive offers at a rate of one in four.", false],
  ["Wages grew by $3 an hour.", "Wages grew by $3 an hour in the last survey.", true],
  ["Programs last two years and cost forty thousand dollars.", "Programs last two years.", false],
];
for (const [i, [text, quote, want]] of FACTS.entries()) Deno.test(`fact probe ${i + 1}: ${want ? "accepts" : "rejects"} "${text.slice(0, 48)}"`, () => { ok(accepts(text, quote) === want); });

// [line, support passages, person facts, message, flagged?]
const LINES: [string, string[], string[], string, boolean][] = [
  ["Ninety percent of applicants are rejected by amazon.", [], [], "", true],
  ["Only seven percent of graduates get offers.", [], [], "", true],
  ["About half of interns convert to full-time.", [], [], "", true],
  ["Interns at goldman earn more than interns elsewhere.", [], [], "", true],
  ["You could join palantir after two years.", [], [], "", true],
  ["Plan to spend five years in the role before you move up.", [], [], "", true],
  ["Hundreds of applicants compete for each seat.", [], [], "", true],
  ["Pay is 6 percent higher in cities.", ["Employment of nurses is projected to grow 6 percent over the decade."], [], "", true],
  ["Ask for one conversation and a second name if it went well.", [], [], "", false],
  ["Build two or three samples and keep them short.", [], [], "", false],
  ["The median annual wage for nurses was $86,070.", ["The median annual wage for nurses was $86,070 in the most recent year."], [], "", false],
  ["You said it has been three months since the bootcamp.", [], [], "I finished a bootcamp three months ago", false],
  ["Your time at palantir is the strongest thing you have.", [], ["Intern at palantir last summer"], "", false],
  ["Employment is projected to grow nine percent over the decade.", ["Employment of financial analysts is projected to grow 9 percent over the decade."], [], "", false],
  ["Amazon is the first firm on your list.", [], [], "", true],
];
for (const [i, [line, support, person, message, want]] of LINES.entries()) Deno.test(`line probe ${i + 1}: ${want ? "flags" : "passes"} "${line.slice(0, 48)}"`, () => { ok((flagged(line, support, person, message).length > 0) === want, JSON.stringify(flagged(line, support, person, message))); });

Deno.test("chat probes: the reviewer's example paragraph and friends fail the lint; a clean one passes", () => {
  const o = { link: "https://f.example/x", facts: [], person: [], message: "how do I get hired as an investment banker" };
  const para = (s: string) => `${s} https://f.example/x`;
  const bad = [
    "Right now ninety percent of freshmen are turned away by amazon, so build a base. Later, small firms are realistic.",
    "Right now the odds are one in ten, so build a base this year. Later, boutique firms are realistic.",
    "Right now goldman will not take a freshman, so build a base this year. Later, boutique firms are realistic.",
    "Right now plan on about seventy thousand dollars at a boutique, so build a base. Later, bigger firms follow.",
  ];
  for (const b of bad) ok(lintChat(para(b), o).some((x) => /no source/.test(x)), b);
  ok(lintChat(para("Right now a summer analyst seat at the largest banks is unlikely, so build a base this year with coursework and a finance club. Later, boutique and middle-market banks are the realistic first rungs, and a first internship there opens larger doors."), o).length === 0);
  ok(unsupported("Pay is eighty thousand dollars.", ["Pay is $80,000."]).length === 0);
});

// ------------------------------------------------------------------------------------------------ round 2 (review of 94dd9308e)
const FACTS2: [string, string, boolean][] = [
  // (1) the claim's SUBJECT must be in the passage near the number; generic words like "earned" and "median" do not count
  ["Electricians earned a median wage of $130,000.", "Software developers earned a median wage of $130,000 in the most recent year.", false],
  ["Electricians earned a median wage of $130,000.", "Electricians earned a median wage of $130,000 in the most recent year.", true],
  ["Nurses earn a median of $86,070.", "The median annual wage for registered nurses was $86,070 in the most recent year.", true],
  ["Plumbers earned a median wage of $61,550.", "Electricians train for years on site and many of them stay with one contractor, while in a separate survey software developers earned a median wage of $61,550.", false],
  ["Teachers will see employment grow 5 percent.", "Employment of nurses is projected to grow 5 percent over the decade.", false],
  ["Dental hygienists must pass two exams.", "Dental hygienists must pass two exams, one written and one clinical.", true],
  ["Pilots earned a median wage of $148,900.", "Flight attendants earned a median wage of $148,900 in the most recent year.", false],
  // (2) full-width digits and symbols are numbers
  ["Median pay was ８４,２００ dollars.", "Median pay for nurses was $84,200 in the most recent year.", true],
  ["Median pay was ８４,２００ dollars.", "Nurses work long shifts and many enjoy the work.", false],
  ["Ｎｉｎｅｔｙ percent are hired.", "Nine out of ten were not hired.", false],
  ["９０％ of graduates are hired.", "Placement data: 90% of graduates are hired within a year.", true],
  // (3) look-alike letters from other alphabets are folded before names are read
  ["Gооgle hires many new graduates.", "Large employers hire new graduates every year.", false],
  ["Gооgle hires many new graduates.", "Google hires many new graduates every year, the report says.", true],
  ["Αmazon hires many new graduates.", "Large employers hire new graduates every year.", false],
  ["Goo​gle hires many new graduates.", "Large employers hire new graduates every year.", false],
];
for (const [i, [text, quote, want]] of FACTS2.entries()) Deno.test(`round 2 fact probe ${i + 1}: ${want ? "accepts" : "rejects"} "${text.slice(0, 44)}"`, () => { ok(accepts(text, quote) === want); });

const LINES2: [string, string[], string[], string, boolean][] = [
  ["Interns earn $８４,２００ a year.", [], [], "", true],
  ["Offers go to ９０％ of finalists.", [], [], "", true],
  ["You could join gооgle after a year.", [], [], "", true],
  ["Interns at Gооgle earn more than interns elsewhere.", [], [], "", true],
  ["Electricians earned a median wage of $130,000.", ["Software developers earned a median wage of $130,000 in the most recent year."], [], "", true],
  ["Interns at Google earn more.", [], ["Intern at Gооgle last summer"], "", false],
  ["The median annual wage for nurses was $84,200.", ["The median annual wage for nurses was $８４,２００ in the most recent year."], [], "", false],
];
for (const [i, [line, support, person, message, want]] of LINES2.entries()) Deno.test(`round 2 line probe ${i + 1}: ${want ? "flags" : "passes"} "${line.slice(0, 44)}"`, () => { ok((flagged(line, support, person, message).length > 0) === want, JSON.stringify(flagged(line, support, person, message))); });

Deno.test("round 2 chat probe: a look-alike name and a full-width figure fail the lint", () => {
  const o = { link: "https://f.example/x", facts: [], person: [], message: "how do I get hired" };
  for (const b of ["Right now Gооgle will not take a freshman, so build a base this year. Later, boutique firms are realistic.", "Right now plan on ９０％ rejection, so build a base this year. Later, boutique firms are realistic."])
    ok(lintChat(`${b} https://f.example/x`, o).some((x) => /no source/.test(x)), b);
});

// ------------------------------------------------------------------------------------------------ round 3 (review of 7ce5a2433)
const FACTS3: [string, string, boolean][] = [
  // every Unicode decimal digit is a digit
  ["Median pay was $٨٤,٢٠٠.", "Median pay for nurses was $84,200 in the most recent year.", true],
  ["Median pay was $٨٤,٢٠٠.", "Nurses work long shifts and many enjoy the work.", false],
  ["Median pay was ८४,२०० dollars.", "Median pay for nurses was $84,200 in the most recent year.", true],
  ["Median pay was ८४,२०० dollars.", "Nurses work long shifts and many enjoy the work.", false],
  ["Median pay was ۸۴٬۲۰۰ dollars.", "Nurses work long shifts and many enjoy the work.", false],
  ["Median pay was 𝟖𝟒,𝟐𝟎𝟎 dollars.", "Nurses work long shifts and many enjoy the work.", false],
  ["٩٠٪ of graduates are hired.", "Placement data: 90% of graduates are hired within a year.", true],
  ["٩٠٪ of graduates are hired.", "Placement data: 19% of graduates are hired within a year.", false],
  // a count is not a percent, a percent is not money, money is not a count
  ["There are 6 openings.", "Employment of nurses is projected to grow 6 percent over the decade.", false],
  ["Openings will grow 6 percent.", "There are 6 openings for nurses this season.", false],
  ["Nurses earned a median wage of $130,000.", "There are 130,000 openings for nurses.", false],
  ["There are 130,000 openings for nurses.", "Nurses earned a median wage of $130,000 in the most recent year.", false],
  ["There are 6 openings for nurses.", "There are 6 openings for nurses this season.", true],
  ["Nurses train for 6 months.", "Nurses train for 6 percent of their shifts on call.", false],
  ["Nurses train for 6 months.", "Nurses train for six months before they start.", true],
  ["Pay ranges from 5 to 10 percent above the base.", "Pay ranges from 5% to 10% above the base.", true],
  // RESEARCH ROUND 3 (2026-11-02): a figure keeps its currency; euros are not the dollars the quote says (D-007).
  ["The median wage was €50,000.", "The median wage was $50,000.", false],
  ["The median wage was €50,000.", "The median wage was €50,000.", true],
  ["The median wage was 50,000 euros.", "The median wage was €50,000.", true],
];
for (const [i, [text, quote, want]] of FACTS3.entries()) Deno.test(`round 3 fact probe ${i + 1}: ${want ? "accepts" : "rejects"} "${text.slice(0, 44)}"`, () => { ok(accepts(text, quote) === want); });
const LINES3: [string, string[], string[], string, boolean][] = [
  ["Interns earn $٨٤,٢٠٠ a year.", [], [], "", true],
  ["Offers go to ٩٠٪ of finalists.", [], [], "", true],
  ["Plan on ८ years before you move up.", [], [], "", true],
  ["There are 6 openings.", ["Employment is projected to grow 6 percent over the decade."], [], "", true],
  ["Pay is 6 percent higher.", ["Pay: 6 openings for nurses."], [], "", true],
];
for (const [i, [line, support, person, message, want]] of LINES3.entries()) Deno.test(`round 3 line probe ${i + 1}: ${want ? "flags" : "passes"} "${line.slice(0, 44)}"`, () => { ok((flagged(line, support, person, message).length > 0) === want, JSON.stringify(flagged(line, support, person, message))); });

// Self-review: 30 fresh adversarial cases designed after the round-3 fix (digits in other scripts, unit kinds, mixed forms).
const ADV: [string, string, boolean][] = [
  ["Nurses earn $84,200.", "Nurses earn $84,200 a year.", true],
  ["Nurses earn 84,200 dollars.", "Nurses earned $84,200 per year.", true],
  ["Nurse pay grew 6%.", "Pay for nurses grew 6 percent.", true],
  ["Nurse pay grew 6%.", "Nurses have 6 openings per hospital.", false],
  ["Nurses work 12 hours.", "Nurses work 12 hour shifts.", true],
  ["Nurses work 12 hours.", "Nurses work 12 percent more overtime.", false],
  ["Nurses work 12 hours.", "Nurses see 12 patients per shift.", false],
  ["Expect 3 years of nurse training.", "Nurses train for three years.", true],
  ["Expect 3 years of nurse training.", "Nurse training has 3 stages.", false],
  ["Nurse pay rose ６ percent.", "Nurse pay rose 6 percent last year.", true],
  ["Nurse pay rose ٦٫٥ percent.", "Nurse pay rose 6.5 percent last year.", true],
  ["Nurse pay rose ٦٫٥ percent.", "Nurse pay rose 65 percent last year.", false],
  ["Nurse pay is ๘๔,๒๐๐ dollars.", "Nurses work long shifts and many enjoy the work.", false],
  ["৯০% of nursing graduates are hired.", "Placement: 90% of nursing graduates are hired.", true],
  ["Nurses earn ₹٨٤,٢٠٠.", "Nurses work long shifts and many enjoy the work.", false],
  ["Nurses earn $84​,200.", "Nurses work long shifts and many enjoy the work.", false],
  ["Nurse pay ranges $٦٠,٠٠٠ to $٩٠,٠٠٠.", "Nurse pay ranges $60,000 to $90,000.", true],
  ["Nursing has 200 thousand openings.", "Nursing: 200,000 openings.", true],
  ["There will be 6 new nursing openings.", "Nursing employment will grow 6 percent.", false],
  ["Nursing employment will grow 6 percent.", "Employment of nurses is projected to grow 6 percent.", true],
  ["Nurses have 6 openings.", "Nurses have 6 job openings.", true],
  ["Nurses make 50% more.", "Nurses make 50 more dollars.", false],
  ["Nurse salaries rose to 130k.", "Nurse salaries rose to 130 percent of the 2020 level.", false],
  ["Nurses earn 84 thousand dollars.", "Nurses earn $84,000 a year.", true],
  ["Nurses earn 84 thousand dollars.", "There are 84 thousand nurses in the state.", false],
  ["A nursing class has 30 students.", "A nursing class has 30 students.", true],
  ["A nursing class has 30 students.", "A nursing class lasts 30 minutes.", false],
  ["Nurses earn 20 dollars an hour.", "Nurses earn $20 per hour.", true],
  ["Nurses earn 20 dollars an hour.", "Nurses need 20 hours of training.", false],
  ["Nurses earn $٢٠ an hour.", "Nurses need 20 hours of training.", false],
];
let advFailed = 0;
for (const [i, [text, quote, want]] of ADV.entries()) Deno.test(`adversarial ${i + 1}: ${want ? "accepts" : "rejects"} "${text.slice(0, 44)}"`, () => { const got = accepts(text, quote); if (got !== want) advFailed++; ok(got === want); });
