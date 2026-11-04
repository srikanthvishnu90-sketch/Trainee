"use strict";
// Synthetic person and answers for the dry-run fixtures (all fake). `answers` are keyed by the question's label, the way the
// approved payload carries them; `must_fill` are labels that must end up filled; `must_ask` are required questions that must be
// handed back when no answer is given (never filled with a default).
const facts = { first_name: "Casey", last_name: "Nguyen", full_name: "Casey Nguyen", email: "casey.nguyen.test@example.invalid", phone: "+1 555 010 0199", linkedin_url: "https://example.invalid/in/casey", github_url: "https://example.invalid/casey", location: "Austin, TX", current_company: "Example Co" };
module.exports = {
  facts,
  interactive: [
    { id: "greenhouse-acme", ats: "greenhouse", file: "greenhouse-acme.html",
      answers: { Country: "United States", "Why do you want to work at Acme?": "Synthetic: I like robots.", "Are you legally authorized to work in the United States?": "Yes, I am authorized to work", "How did you hear about this job?": "Referral", "Which languages do you use at work? (select all that apply)": "Python; Go", "I acknowledge the privacy notice": "yes" },
      must_fill: ["First Name", "Last Name", "Email", "Phone", "Country", "Resume/CV", "Why do you want to work at Acme?", "Are you legally authorized to work in the United States?", "I acknowledge the privacy notice", "Which languages do you use at work? (select all that apply)"],
      expect_selected: { "Country": ["United States"], "Are you legally authorized to work in the United States?": ["Yes, I am authorized to work"], "How did you hear about this job?": ["Referral"], "Which languages do you use at work? (select all that apply)": ["Python", "Go"] },
      expect_eeo_decline: { "Gender": ["Decline to self-identify"], "Veteran Status": ["I do not wish to answer"], "Disability Status": ["I do not want to answer"] },
      must_ask: ["Country", "Why do you want to work at Acme?", "Are you legally authorized to work in the United States?", "I acknowledge the privacy notice"] },
    { id: "lever-acme", ats: "lever", file: "lever-acme.html",
      answers: { "Do you now, or in the future require sponsorship?": "No", "What are your salary expectations?": "Synthetic: open", "Which regions can you work in?": "North America, Europe", "How did you hear about us?": "Friend" },
      must_fill: ["Resume/CV", "Full name", "Email", "Phone", "Current location", "Current company", "LinkedIn URL", "GitHub URL", "Do you now, or in the future require sponsorship?", "What are your salary expectations?"],
      expect_selected: { "Do you now, or in the future require sponsorship?": ["No"], "Which regions can you work in?": ["North America", "Europe"], "How did you hear about us?": ["Friend"] },
      expect_eeo_decline: { "Gender": ["Decline to self-identify"], "Race": ["Decline to self-identify"], "Veteran status": ["Decline to self-identify"] },
      must_ask: ["Do you now, or in the future require sponsorship?", "What are your salary expectations?"] },
    { id: "ashby-acme", ats: "ashby", file: "ashby-acme.html",
      answers: { "Are you legally authorized to work in the United States?": "Yes", "Will you require visa sponsorship?": "No", "Which office would you work from?": "Remote", "Teams of interest": "Perception; Platform", "Tell us about a project you are proud of": "Synthetic: a rover." },
      must_fill: ["Name", "Email", "Resume", "Phone Number", "LinkedIn", "Are you legally authorized to work in the United States?", "Will you require visa sponsorship?", "Which office would you work from?", "Tell us about a project you are proud of"],
      expect_selected: { "Are you legally authorized to work in the United States?": ["Yes"], "Will you require visa sponsorship?": ["No"], "Which office would you work from?": ["Remote"], "Teams of interest": ["Perception", "Platform"] },
      expect_eeo_decline: { "Voluntary self-identification: Veteran status": ["I prefer not to say"], "Gender": ["Decline to self-identify"] },
      must_ask: ["Are you legally authorized to work in the United States?", "Will you require visa sponsorship?", "Which office would you work from?", "Tell us about a project you are proud of"] },
  ],
};
