// WO-020: the facts a person gives once, and what kind each application question is (see `note`). A TS module, not
// JSON: every edge import must load as a plain ES module (the staged-handler tests link each file as one, and a JSON
// import attribute does not link there).
export const FACT_SCHEMA = {
 "version": 1,
 "author": "architect",
 "note": "WO-020: the facts a person gives once, and what every application question is, by meaning. kind: fact = about the person, the same answer for every employer; derived = computed from a fact plus the posting (worked here before, a relative here, the posting's city); screen = about this job (onsite days in its city, travel, lifting, a stated skill or years with a named tool): answered from the person's stated preferences and confirmed facts where one says it, otherwise asked in the approval; attestation = a legal statement only the person makes (criminal history, export control, government employment): never answered from a default, always shown in the approval as theirs; consent = an acknowledgement, privacy notice, certification or opt-in: shown in the approval as one tap, never ticked silently; essay = a written answer: drafted only from confirmed facts and the company's own record, shown in full in the approval; file = a document upload; unknown = not understood: asked. The question map picks a fact and, where the form offers options, the option; it never writes a value. Values come only from what the person stated and confirmed (D-007).",
 "kinds": [
  "fact",
  "derived",
  "screen",
  "attestation",
  "consent",
  "essay",
  "file",
  "unknown"
 ],
 "facts": {
  "full_name": {
   "kind": "fact",
   "type": "text",
   "group": "identity"
  },
  "legal_name": {
   "kind": "fact",
   "type": "text",
   "group": "identity",
   "note": "full legal name; native-script name is a separate ask"
  },
  "first_name": {
   "kind": "fact",
   "type": "text",
   "group": "identity"
  },
  "last_name": {
   "kind": "fact",
   "type": "text",
   "group": "identity"
  },
  "preferred_name": {
   "kind": "fact",
   "type": "text",
   "group": "identity"
  },
  "preferred_last_name": {
   "kind": "fact",
   "type": "text",
   "group": "identity",
   "note": "only what the person stated; never their legal last name or preferred first name (WO-042)"
  },
  "pronouns": {
   "kind": "fact",
   "type": "enum",
   "group": "identity",
   "values": [
    "she/her",
    "he/him",
    "they/them",
    "decline"
   ]
  },
  "email": {
   "kind": "fact",
   "type": "text",
   "group": "contact"
  },
  "phone": {
   "kind": "fact",
   "type": "text",
   "group": "contact"
  },
  "phone_type": {
   "kind": "fact",
   "type": "enum",
   "group": "contact",
   "note": "the phone's device type as the person stated it (mobile, landline); WO-048"
  },
  "street_address": {
   "kind": "fact",
   "type": "text",
   "group": "address"
  },
  "full_address": {
   "kind": "fact",
   "type": "text",
   "group": "address",
   "note": "street, city, state, postal code in one line"
  },
  "city": {
   "kind": "fact",
   "type": "text",
   "group": "address"
  },
  "state": {
   "kind": "fact",
   "type": "text",
   "group": "address",
   "note": "US state or province; 'not in the US' when abroad"
  },
  "postal_code": {
   "kind": "fact",
   "type": "text",
   "group": "address"
  },
  "country": {
   "kind": "fact",
   "type": "text",
   "group": "address"
  },
  "location": {
   "kind": "fact",
   "type": "text",
   "group": "address",
   "note": "city, state as one answer"
  },
  "timezone": {
   "kind": "fact",
   "type": "text",
   "group": "address"
  },
  "linkedin": {
   "kind": "fact",
   "type": "url",
   "group": "links"
  },
  "github": {
   "kind": "fact",
   "type": "url",
   "group": "links"
  },
  "website": {
   "kind": "fact",
   "type": "url",
   "group": "links",
   "note": "portfolio or personal site"
  },
  "resume": {
   "kind": "file",
   "type": "file",
   "group": "documents"
  },
  "cover_letter": {
   "kind": "file",
   "type": "file",
   "group": "documents"
  },
  "transcript": {
   "kind": "file",
   "type": "file",
   "group": "documents"
  },
  "portfolio_file": {
   "kind": "file",
   "type": "file",
   "group": "documents"
  },
  "writing_sample": {
   "kind": "file",
   "type": "file",
   "group": "documents"
  },
  "current_employer": {
   "kind": "fact",
   "type": "text",
   "group": "work",
   "note": "current or most recent"
  },
  "current_title": {
   "kind": "fact",
   "type": "text",
   "group": "work"
  },
  "employment_status": {
   "kind": "fact",
   "type": "enum",
   "group": "work",
   "values": [
    "employed",
    "not_employed",
    "student"
   ]
  },
  "years_experience": {
   "kind": "fact",
   "type": "number",
   "group": "work",
   "note": "total relevant professional years"
  },
  "former_employers": {
   "kind": "fact",
   "type": "list",
   "group": "work",
   "note": "every employer, confirmed complete; 'worked here before' is derived from it"
  },
  "notice_period": {
   "kind": "fact",
   "type": "text",
   "group": "availability",
   "note": "e.g. 2 weeks, immediately"
  },
  "start_date": {
   "kind": "fact",
   "type": "date",
   "group": "availability"
  },
  "employment_type": {
   "kind": "fact",
   "type": "enum",
   "group": "availability",
   "values": [
    "full_time",
    "part_time",
    "contract",
    "internship"
   ]
  },
  "salary_expectation": {
   "kind": "fact",
   "type": "text",
   "group": "pay"
  },
  "current_compensation": {
   "kind": "fact",
   "type": "text",
   "group": "pay"
  },
  "salary_currency": {
   "kind": "fact",
   "type": "text",
   "group": "pay"
  },
  "pay_range_ok": {
   "kind": "screen",
   "type": "yesno",
   "group": "pay",
   "note": "the posted range meets their expectations: asked per application (D-053c); never from salary_expectation, a pay_range_ok fact or another posting's answer"
  },
  "work_history": {
   "kind": "fact",
   "type": "list",
   "group": "work",
   "note": "WO-048: the jobs the person stated, as a JSON list of {employer, title, start, end, location?, description?}; dates as stated (MM/YYYY, or a year), end 'present' for the current job. Repeating work-experience rows are filled only from this; a part never stated is asked"
  },
  "education_level": {
   "kind": "fact",
   "type": "enum",
   "group": "education",
   "values": [
    "high_school",
    "associate",
    "bachelor",
    "master",
    "doctorate",
    "some_college"
   ]
  },
  "school": {
   "kind": "fact",
   "type": "text",
   "group": "education"
  },
  "major": {
   "kind": "fact",
   "type": "text",
   "group": "education"
  },
  "gpa": {
   "kind": "fact",
   "type": "number",
   "group": "education",
   "note": "4.0 scale; 'not applicable' is an answer"
  },
  "graduation_date": {
   "kind": "fact",
   "type": "date",
   "group": "education"
  },
  "test_scores": {
   "kind": "fact",
   "type": "text",
   "group": "education",
   "note": "SAT/ACT/GRE as the person states them, or 'did not take'"
  },
  "languages_other": {
   "kind": "fact",
   "type": "text",
   "group": "skills",
   "note": "languages besides the person's first language; their language fact alone does not answer it (WO-042)"
  },
  "languages": {
   "kind": "fact",
   "type": "list",
   "group": "skills",
   "note": "each with a level"
  },
  "certifications": {
   "kind": "fact",
   "type": "list",
   "group": "skills"
  },
  "drivers_license": {
   "kind": "fact",
   "type": "yesno",
   "group": "skills"
  },
  // ELIGIBILITY-SEPARATION-PROPOSAL.md (Branch A note): work
  // authorization is its own fact — authorized to work in the US, yes
  // or no; sponsorship is its own fact (the "sponsorship" entry below),
  // never part of this one's meaning. The entry's "note" string below is
  // schema data and is unchanged here; this comment records the
  // separation the proposal's readers (module 156) implement.
  "work_authorization": {
   "kind": "fact",
   "type": "text",
   "group": "authorization",
   "note": "countries where they may work without sponsorship"
  },
  "sponsorship": {
   "kind": "fact",
   "type": "yesno",
   "group": "authorization",
   "note": "needs sponsorship now or in the future"
  },
  "citizenship": {
   "kind": "fact",
   "type": "text",
   "group": "authorization",
   "note": "country or countries; US status (citizen, permanent resident, other)"
  },
  "us_person": {
   "kind": "attestation",
   "type": "yesno",
   "group": "authorization",
   "note": "export-control 'U.S. person'; the person's own statement"
  },
  "security_clearance": {
   "kind": "fact",
   "type": "text",
   "group": "authorization",
   "note": "level held, or none; eligibility is asked"
  },
  "over_18": {
   "kind": "fact",
   "type": "yesno",
   "group": "identity"
  },
  "relocation": {
   "kind": "fact",
   "type": "text",
   "group": "preferences",
   "note": "willing to relocate, and where"
  },
  "onsite_ok": {
   "kind": "fact",
   "type": "text",
   "group": "preferences",
   "note": "how many office days a week they accept; a posting's city makes a screen"
  },
  "travel_ok": {
   "kind": "fact",
   "type": "text",
   "group": "preferences",
   "note": "share of travel accepted"
  },
  "how_heard": {
   "kind": "fact",
   "type": "text",
   "group": "application",
   "note": "default answer the person chose, e.g. the company's careers page"
  },
  "referral": {
   "kind": "derived",
   "type": "text",
   "group": "application",
   "note": "a referrer named for this company, else 'not referred'"
  },
  "worked_here_before": {
   "kind": "derived",
   "type": "yesno",
   "group": "application",
   "note": "this company or its affiliates in former_employers"
  },
  "relative_here": {
   "kind": "derived",
   "type": "yesno",
   "group": "application",
   "note": "a relative at this company, from what the person stated"
  },
  "applied_before": {
   "kind": "derived",
   "type": "yesno",
   "group": "application",
   "note": "from Trainee's own application record and what the person stated"
  },
  "non_compete": {
   "kind": "attestation",
   "type": "yesno",
   "group": "legal"
  },
  "criminal_history": {
   "kind": "attestation",
   "type": "yesno",
   "group": "legal"
  },
  "government_employment": {
   "kind": "attestation",
   "type": "yesno",
   "group": "legal"
  },
  "background_check_ok": {
   "kind": "consent",
   "type": "yesno",
   "group": "legal"
  },
  "eeo": {
   "kind": "fact",
   "type": "enum",
   "group": "voluntary",
   "note": "gender, race, veteran, disability: only what the person chose, 'decline to answer' included"
  },
  "sms_opt_in": {
   "kind": "consent",
   "type": "yesno",
   "group": "consent"
  },
  "marketing_opt_in": {
   "kind": "consent",
   "type": "yesno",
   "group": "consent"
  },
  "privacy_ack": {
   "kind": "consent",
   "type": "ack",
   "group": "consent"
  },
  "certify_true": {
   "kind": "consent",
   "type": "ack",
   "group": "consent"
  },
  "ai_policy_ack": {
   "kind": "consent",
   "type": "ack",
   "group": "consent"
  },
  "essential_functions": {
   "kind": "screen",
   "type": "yesno",
   "group": "job"
  },
  "meets_qualifications": {
   "kind": "screen",
   "type": "yesno",
   "group": "job"
  },
  "clearance_eligibility": {
   "kind": "fact",
   "type": "yesno",
   "group": "authorization",
   "note": "able to obtain a U.S. security clearance; never inferred from holding none (WO-042)"
  },
  "job_commute": {
   "kind": "screen",
   "type": "yesno",
   "group": "job",
   "note": "lives within commuting distance of this posting's office: no stated preference answers it (WO-042)"
  },
  "job_onsite": {
   "kind": "screen",
   "type": "yesno",
   "group": "job",
   "note": "this posting's office days and city"
  },
  "job_relocation": {
   "kind": "screen",
   "type": "yesno",
   "group": "job",
   "note": "relocate to this posting's city"
  },
  "job_travel": {
   "kind": "screen",
   "type": "yesno",
   "group": "job"
  },
  "job_physical": {
   "kind": "screen",
   "type": "yesno",
   "group": "job",
   "note": "lifting, standing, climbing"
  },
  "job_schedule": {
   "kind": "screen",
   "type": "text",
   "group": "job",
   "note": "shifts, overtime, weekends, time zone hours"
  },
  "job_experience": {
   "kind": "screen",
   "type": "text",
   "group": "job",
   "note": "years or yes/no with a named tool, domain or task"
  },
  "job_location_choice": {
   "kind": "screen",
   "type": "text",
   "group": "job",
   "note": "which of the posting's offices"
  },
  "essay_why_company": {
   "kind": "essay",
   "type": "text",
   "group": "essay"
  },
  "essay_experience": {
   "kind": "essay",
   "type": "text",
   "group": "essay",
   "note": "describe a project, a hard problem, an achievement, fit"
  },
  "essay_cover_letter": {
   "kind": "essay",
   "type": "text",
   "group": "essay",
   "note": "a cover letter typed into a text box; an upload is cover_letter"
  },
  "essay_other": {
   "kind": "essay",
   "type": "text",
   "group": "essay"
  },
  "references": {
   "kind": "fact",
   "type": "list",
   "group": "application"
  },
  "signature": {
   "kind": "attestation",
   "type": "text",
   "group": "legal",
   "note": "the person's typed name as their signature"
  }
 }
} as const;
export default FACT_SCHEMA;
