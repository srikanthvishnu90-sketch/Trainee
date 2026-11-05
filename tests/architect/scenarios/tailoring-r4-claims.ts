// The decoy and claim corpora of tailoring round 4's reviews (#507, #512), shared by scenarios-tailoring-r4.test.ts and
// claims-floor.test.ts (moved here unchanged from scenarios-tailoring-r4.test.ts so a test can read them without
// registering round 4's battery).
export const R4_DECOYS: { text: string; record: string; why: string }[] = [
  { text: "As a Black woman in data, I bring a different lens.", record: "Six Sigma Black Belt certification", why: "identity" },
  { text: "As a white man in tech, I know my privilege.", record: "Wrote white papers on caching", why: "identity" },
  { text: "As an immigrant, I learned resilience.", record: "Taught English to immigrant families as a volunteer", why: "identity" },
  { text: "As a first-generation college student, I worked through school.", record: "Mentor, First-Generation Student Program at State University", why: "identity" },
  { text: "As a Black woman in data, I bring a different lens.", record: "Black and white film photography", why: "identity" },
  { text: "As a Black woman in data, I bring a different lens.", record: "Chair, Black, Asian and Minority Ethnic staff network", why: "identity" },
  { text: "As a white man in tech, I know my privilege.", record: "White and gray box testing of APIs", why: "identity" },
  { text: "As an Asian woman in finance, I bring a different lens.", record: "Asian and European equities desk", why: "identity" },
  { text: "As a woman in healthcare, I bring a different lens.", record: "Woman and Child Health Initiative volunteer", why: "identity" },
  { text: "As a man in nursing, I bring a different lens.", record: "Man and Van moving company owner", why: "identity" },
  { text: "As a Black engineer, I bring a different lens.", record: "Skills: Python, Black, Ruff, mypy", why: "identity" },
  { text: "I have never been convicted of a crime.", record: "B.A. Criminal Justice, State University", why: "criminal history" },
  { text: "I can start immediately.", record: "Made sales dashboards available to the whole team", why: "start date" },
  { text: "I am seeking a base salary in the low six figures.", record: "Built a salary benchmarking model", why: "salary" },
  { text: "I am happy to relocate for this role.", record: "Not willing to relocate", why: "relocation" },
  { text: "I have never been convicted of a crime.", record: "Has a misdemeanor conviction", why: "criminal history" },
  { text: "I can start immediately.", record: "Available from June", why: "start date" },
  { text: "I can start next week.", record: "Notice period negotiated with HR", why: "start date" },
  { text: "I have no felony convictions.", record: "Felony Trial Unit, District Attorney's Office", why: "criminal history" },
  { text: "I will pass a drug test.", record: "Drug testing lab technician", why: "drug test" },
  { text: "My salary expectations are flexible.", record: "Compensation range analysis for new roles", why: "salary" },
  { text: "I have no criminal record.", record: "Responsible for criminal background checks", why: "criminal history" },
  // a confirmed answer in the person's own words is still not written into prose: the form asks it
  { text: "As a first-generation college student, I worked through school.", record: "I am a first-generation college student", why: "identity (confirmed)" },
  { text: "I have never been convicted of a crime.", record: "Has never been convicted of a crime", why: "criminal history (confirmed)" },
  { text: "I can start immediately.", record: "Available to start immediately", why: "start date (confirmed)" },
  { text: "I am seeking a base salary in the low six figures.", record: "Looking for a salary in the low six figures", why: "salary (confirmed)" },
];

export const R512_CLAIMS: { text: string; why: "identity" | "screening" }[] = [
  ...[
    "I am Black and I care about fairness.", "Being a Black woman in data, I bring a different lens.", "As someone who is Black, I bring a different lens.",
    "As a proud Black analyst, I bring a different lens.", "As a young Asian woman, I bring a different lens.", "I'm a proud immigrant.",
    "As a single mother, I am resilient.", "As a working mom, I plan my weeks with care.", "I'm Jewish and I value learning.",
    "As the daughter of immigrants, I learned resilience.", "I am the first in my family to attend college.", "I identify as queer.",
    "I identify as nonbinary.", "As a person of color, I bring a different lens.", "As a Latina in data, I bring a different lens.",
    "As a Hispanic analyst, I bring a different lens.", "As a gay man, I bring a different lens.", "As an LGBTQ engineer, I bring a different lens.",
  ].map((text) => ({ text, why: "identity" as const })),
  ...[
    "I'd relocate for this role.", "I am open to relocation.", "I will pass any background screening.", "I have never been charged with a crime.",
    "I have no prior offenses.", "I have no criminal records.", "I'm drug-free.", "My expected salary is $120,000.", "My desired salary is $120,000.",
    "My target compensation is $150k.", "I'm looking for $120,000.", "I can start in 2 weeks.", "I could begin in two weeks.",
  ].map((text) => ({ text, why: "screening" as const })),
];

export const R512_RECORDS = (claim: string): string[] => [
  "", "Six Sigma Black Belt certification", "Black and white film photography", "Skills: Python, Black, Ruff, mypy",
  "Chair, Black, Asian and Minority Ethnic staff network", "Raised $120,000 and $150k for the food bank in 2 weeks",
  "Member, Hispanic Scholarship Fund", "Latina Leadership Network", "Volunteer, Jewish Community Center; Gay-Straight Alliance mentor", claim,
];

export const R512_WORK: { text: string; record: string }[] = [
  { text: "I ran background checks for 300 new hires.", record: "Ran background checks for 300 new hires" },
  { text: "I built a salary range model.", record: "Built a salary range model" },
  { text: "I prosecuted felony cases in the Felony Trial Unit.", record: "Prosecuted felony cases in the Felony Trial Unit" },
  { text: "I coordinated drug testing for 300 drivers.", record: "Coordinated drug testing for 300 drivers" },
  { text: "I managed the office relocation.", record: "Managed the office relocation" },
  { text: "I analyzed crime data for the city.", record: "Analyzed crime data for the city" },
  // look-alike words that are no identity: a compound, an organisation the person named
  { text: "As a Six Sigma Black Belt, I cut waste.", record: "Six Sigma Black Belt certification; cut waste" },
  { text: "I used white-box testing on our APIs.", record: "White and gray box testing of APIs" },
  { text: "As a Girl Scout leader, I taught budgeting.", record: "Girl Scout leader; taught budgeting" },
];
