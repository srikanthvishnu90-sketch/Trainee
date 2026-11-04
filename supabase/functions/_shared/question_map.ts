// WO-020: what an application question asks, by meaning (_shared/fact_schema.ts). The map names a fact and
// its kind; it never writes a value. Values come only from what the person stated and confirmed (D-007), and what each
// kind may do is the schema's: a fact or derived answer fills the form, a screen, attestation, consent or essay is shown
// in the approval, unknown is asked. Rules run in order and the first that matches wins; each names why it matched.
// Wording, punctuation, numbering and the employer's name do not matter; English, French, Dutch, Spanish and Japanese
// labels seen on real forms are read. This is the code layer; a question it cannot place stays unknown (never forced).
import schema from "./fact_schema.ts";

export type Kind = "fact" | "derived" | "screen" | "attestation" | "consent" | "essay" | "file" | "unknown";
export interface MappedQuestion { fact: string; kind: Kind; why: string }
export interface Question { label: string; type?: string; options?: { label: string }[] }

const FACTS = (schema as any).facts as Record<string, { kind: Kind }>;
// Languages named in a question about one language's level (WO-048 round 2).
export const LANGUAGE_NAMES = ["english", "spanish", "french", "german", "mandarin", "chinese", "cantonese", "japanese", "korean", "portuguese", "italian",
  "dutch", "arabic", "hindi", "russian", "polish", "turkish", "vietnamese", "tagalog", "swedish", "hebrew", "greek"];
export const kindOf = (fact: string): Kind => (FACTS[fact]?.kind ?? "unknown") as Kind;

// The text a rule reads: lowercase, accents kept (French), numbering and markdown stripped, spaces collapsed.
export function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/^\s*(\(?\d+[a-z]?[.)]|[a-z]\))\s*/, "").replace(/\s+/g, " ").trim();
}
const FILE_TYPES = new Set(["input_file", "file"]);
const LONG_TYPES = new Set(["textarea"]);

type Rule = [fact: string, test: RegExp, when?: (q: Question, t: string) => boolean];
const isFile = (q: Question) => FILE_TYPES.has(String(q.type));
const notFile = (q: Question) => !isFile(q);
const opts = (q: Question) => (q.options || []).map((o) => String(o.label).toLowerCase()).join(" | ");
const yesNoOnly = (q: Question) => !q.options?.length || /^(yes|no|sí|si|ja|nee|はい|いいえ|n\/a|not sure|i'?m not sure| \| )+$/i.test(opts(q).replace(/[.\s]+/g, " ").replace(/ \| /g, " | ").trim()) || q.options!.every((o) => /^(yes|no)\b/i.test(String(o.label).trim()));

const WHY = /\bwhy\b(?!.*\b(good|great) fit\b)(?!.*\bwhy you'?re\b)|pourquoi|por qué|\binterest(s|ed)? you\b|\bexcites? you\b|\bexcited about\b|\bresonate|\bdrew you|\bwhat interested you\b|\bwhy are you interested\b|\bwhy do you want\b|\bmakes you excited\b|\bwhat makes you want\b/;
const DESCRIBE = /\b(describe|tell us|share|walk us through|give an example|provide an example|example of|explain|what is one|what's something|what are you most proud|most proud|hardest|exceptional|achieve|accomplish|built|project|summary about yourself|good fit|great fit|why you'?re|what attributes|philosophy|how do you|how have you|what skills|what relevant|elaborate|brief comment|in \d+ (words|sentences)|in fewer than|in 1-3)\b/;

// WO-052 (independent review of every fill): a standing consent covers what it names and nothing more. An agreement to
// arbitrate, a confidentiality or non-disclosure agreement, terms and conditions, a whistleblower policy, sharing the
// person's data with others or keeping it for other roles, being recorded, monitored or matched by AI: the person's own.
// WO-058 (sample G): the question a label asks is its last sentence with a "?" ("Candidates must be authorized ... without
// sponsorship. Are you legally authorized to work for ANY employer in the United States?" asks the authorization).
function authorizationAsked(t: string): boolean {
  const asked = t.replace(/\b(?:[a-z]\.){2,}/g, (a) => a.replace(/\./g, "\u2024")).split(/(?<=[.?!])\s+/).filter((x) => x.includes("?")).pop() ?? "";
  return /\b(authori[sz]ed|eligible|entitled) to work\b|\bright to work\b|\bwork authori[sz]ation\b|\bauthori[sz]ation to work\b/.test(asked) && !/sponsor|visa/.test(asked);
}
const BEYOND_CONSENT = /marketing|disclos(ed|e) to (other|our|its|any)|\b(group|sister|affiliated) (entities|companies)\b|other [\w& -]{0,30}\bentities\b|considered for (all|other|any)|arbitrat|confidential|non-?disclosure|\bnda\b|terms (and|&) conditions|terms of (use|service)|whistle|third[- ]part|\bshare (your|my|the)? ?(data|information)|share your data|collaborate and share|improve our|future (opportunit|vacanc|role|position)|talent (pool|community|matching)|retain|notetaker|record|transcri|monitor|qualifications|drug|substance|at[- ]will|\bi (also|further) agree|further (agree|understood)|credit (check|report|histor)|reference check|in consideration of (my|your|the) employment/;
const ackOpt = (x: string) => /^(i )?(acknowledge|agree|accept|understand|consent|confirm)|^acknowledge\/confirm|^read and understood|^i will read/.test(x);
function ackShaped(q: Question, t: string): boolean {
  const o = (q.options || []).map((x) => String(x.label).toLowerCase().trim());
  const onlyAck = o.length > 0 && o.every(ackOpt);
  const statement = o.length > 0 && o.some(ackOpt) && o.every((x) => ackOpt(x) || /^i (am not|do not|don'?t)\b.*\b(agree|acknowledge|agreement)/.test(x)) && t.length > 80;
  return (onlyAck || statement || (q.type === "checkbox" && t.length > 100 && !t.includes("?"))) && !/on-?site|in-?office|in office|relocat|days (a|per) week/.test(t);
}

// Where the person lives, as a location question asks it.
const RESIDENCE = /\bwhere (are|do) you (currently )?(located|live|reside|based)\b|\bcurrent(ly)? located\b|\bcity and state\b|\bcurrent location\b|^your location\b|^location\b|\bwhere are you located\b|\bare you (currently )?(based|located|local) in\b|\bdo you (currently )?(live|reside) in\b|\bplease confirm that you are based\b/;
// The same sentence asking where the person is and their right to work there (FRS QA bug 4).
const RESIDENCE_ASKED = /\bwhere (are|do) you (currently )?(located|live|reside|based)\b|\bare you (currently )?(based|located|local) in\b|\bdo you (currently )?(live|reside) in\b|\bplease confirm that you are based\b/;
const WORK_RIGHTS = /\bright to work\b|\bauthori[sz](ed|ation)\b|\beligib\w*\b|\bwork permit\b|\bvisa\b|\bsponsor/;
// Ordered: files, then identity and contact, address, links, work, availability, pay, education, skills, authorization,
// legal, consent, application, job screens, essays. A rule's `when` narrows it (a type, a shape of options).
const RULES: Rule[] = [
  // Files: the input decides; the label names which document.
  ["resume", /\b(resume|résumé|cv|curriculum)\b/, isFile],
  ["cover_letter", /\bcover letter|lettre de motivation|motivatiebrief\b/, isFile],
  ["transcript", /\btranscript/, isFile],
  ["portfolio_file", /\bportfolio\b/, isFile],
  ["writing_sample", /\bwriting sample\b/, isFile],
  ["unknown", /.*/, isFile],
  ["resume", /^(resume|résumé|cv)( ?\/ ?(cv|resume))?$/],
  // FRS: a cover letter typed into a text box is a written answer (drafted on the card from confirmed facts, kept for
  // this posting only); "in lieu of a cover letter, share ..." is read by the essay rules below.
  ["essay_cover_letter", /\bcover letter|lettre de motivation|motivatiebrief\b/, (q, t) => LONG_TYPES.has(String(q.type)) && !/\b(in lieu of|instead of)\b/.test(t)],

  // A statement the person accepts (its only answers are acknowledgements, or a long checkbox with no question) is a
  // consent only when it is one a standing consent covers: privacy and data, certifying the answers are true, the
  // employer's AI-use policy. Any other statement (a faith commitment, a code of conduct, a firearms questionnaire) is
  // the person's own call: asked, or read by the rules below.
  ["ai_policy_ack", /\bai\b|artificial intelligence/, (q, t) => ackShaped(q, t) && !BEYOND_CONSENT.test(t + " " + opts(q))],
  ["certify_true", /\bcertif|\btrue and|\baccurate\b|applicant'?s statement/, (q, t) => ackShaped(q, t) && !BEYOND_CONSENT.test(t + " " + opts(q))],
  ["privacy_ack", /privacy|personal (data|information)|data (protection|processing)|\bccpa\b|consumer privacy|notice to (applicants|candidates)/, (q, t) => ackShaped(q, t) && !BEYOND_CONSENT.test(t + " " + opts(q))],
  // WO-052: a box to check under the export-control "U.S. person" definition (Saronic) is the person's U.S.-person
  // statement, the same attestation as the question that asks it outright; only a stated "yes" ever checks it.
  ["us_person", /\bu\.?s\.? person\b/, (q, t) => q.type === "checkbox" && ackShaped(q, t)],
  // A notice named only in its option ("Please review the linked document:" over "I acknowledge ... Privacy Notice").
  ["privacy_ack", /.*/, (q, t) => ackShaped(q, t) && /privacy/.test(opts(q)) && !BEYOND_CONSENT.test(t + " " + opts(q))],
  ["unknown", /.*/, (q, t) => ackShaped(q, t) && !/firearms|prohibited possessor/.test(t)],

  // Identity.
  ["legal_name", /\bfull legal name\b|legal (first|last)? ?name and legal|^legal name\b/, (q, t) => !/native language|referr|team member/.test(t)],
  ["first_name", /^(legal )?first name\b|^given name\b|^prénom\b|^voornaam\b|^名$/],
  ["last_name", /^(legal )?(last|family) name\b|^surname\b|^nom( de famille)?$|^achternaam\b|^姓$/],
  // A preferred last name is not the preferred (first) name the person gave: left to them (WO-042, Harvey).
  ["preferred_last_name", /^preferred (last|family|sur) ?name\b/],
  ["preferred_name", /^preferred (first )?name\b/],
  ["pronouns", /\bpronouns?\b/],
  ["full_name", /^(full )?name\b|^your name\b|^nom complet\b/, (q, t) => !/referr|company|school|university|employer/.test(t)],
  ["signature", /^signature\b|\bsign(ature)? (here|below)\b|\btype your (full )?name\b/],
  ["email", /^e-?mail( address)?$|^email address\b|^電子メール$|^adresse e-?mail\b|^your e-?mail\b/],
  // WO-048 (Workday's My Information): the phone's device type is its own fact, and an extension is never the number.
  ["phone_type", /^(phone )?device type\b|^phone (number )?type\b|^type of phone\b/],
  ["unknown", /^(phone )?ext(ension)?\b|^phone (number )?extension\b/],
  ["phone", /^(mobile |cell )?phone( number)?\b|^telephone\b|^telefoon\b|^téléphone\b|^電話$|^contact number\b/],

  // Address and location.
  // A second address line is never the full address (WO-048, Workday's "Address Line 2").
  ["unknown", /^address line (2|3|two|three)\b|^address 2\b|^(apt|apartment|suite|unit)\b/],
  ["street_address", /\bstreet address\b|^(primary |home |mailing |permanent )?address line 1\b|^street\b/, (q, t) => !/\bcity\b.*\bstate\b|\bzip\b|full street address/.test(t)],
  ["full_address", /\b(full |physical |residential |home |legal |permanent |primary residence |current residential |complete current residential )?address\b/, (q, t) => !/e-?mail|ip address|work address|\baddress:? ?-? ?(city|town|zip|postal|post ?code|state|province|country|line ?[1-3])\b|\b(staying|living|located|residing) in (?!the (u\.?s\.?|united states))[a-z]/.test(t) && t.length <= 100 && !/\b(did|do|will|would|to|you|we|they) address\b/.test(t)],
  ["unknown", /\bcity\b.*\b(zip|postal|country)\b|\b(zip|postal)\b.*\bcity\b/],
  ["postal_code", /\b(zip|postal|post) ?(\/ ?postal )?code\b|^zip\b|\bcode postal\b/],
  ["city", /\bwhat city do you (currently )?(live|reside)|which city are you|^city\b|^ville\b|\blocation:? city\??$|^(primary |home |mailing |permanent )?address city\b/, (q, t) => !/\bstate\b/.test(t)],
  ["state", /^state( or province| \/ province)?\b|\bstate of residence\b|\bwhat (u\.?s\.? )?state\b|\bin which (u\.?s\.? )?state\b|\bwhich (u\.?s\.? )?state\b|\bpermanent work location\b/, (q, t) => !/\bcity\b|certif|licen[cs]|granted|issued/.test(t)],
  ["timezone", /\btime ?zone are you\b|\bwhat time ?zone\b|\btime zone you are located\b|\bwhich time zone\b/],
  ["country", /\b(live|reside|based|located) in (the )?(united states|u\.?s\.?a?|canada|united kingdom)\b\??$/, (q, t) => !/\b(employer|company|organi[sz]ation|team|office|headquarters?|client|manager|referr\w*)\b/.test(t)],
  // WO-047: "Do you currently reside in the U.S.?" (no word edge after "U.S.") and "Are you based in the U.S.? We are only
  // able to hire within the U.S." ask where the person lives, by country; "Are you currently located in Canada or the
  // U.S?" names two. Only about the person ("you ... located in"), never compound with authorization, a move or a distance.
  ["country", /\byou (are )?(currently |presently |now )?(live|living|reside|residing|based|located) in (the )?(united states( of america)?|u\.s\.a\.?|u\.s\.?|usa|us|canada|united kingdom|uk)( or (the )?(united states( of america)?|u\.s\.a\.?|u\.s\.?|usa|us|canada|united kingdom|uk))?(?![a-z])/, (q, t) => !/authori|sponsor|visa|able to work|right to work|willing|relocat|commut|eligib|permit|miles|within \d|citizen/.test(t)],
  ["country", /\b(what|which|in which|in what) country\b.*\b(live|reside|resident|based|currently)\b|\bcountry (where you|of residence)\b|^country\b|^select country\b|^pays\b/, (q, t) => !/citizen|nationality|right to work|authori[sz]ed|anticipate/.test(t)],
  // FRS QA bug 4 (Prolific): "Are you currently based in and can verify right to work from one of the following
  // countries?" asks where the person is AND their right to work there: never the location fact alone (one half). Asked.
  ["unknown", RESIDENCE, (q, t) => t.split(/(?<=[.?!])\s+/).some((x) => RESIDENCE_ASKED.test(x) && WORK_RIGHTS.test(x))],
  ["location", RESIDENCE, (q, t) => !/relocat|office|on-?site|hybrid|commut|in person|in-person/.test(t)],

  ["how_heard", /\bhoe ben je\b.*\b(gekomen|terechtgekomen)\b|\bhow did you (first |initially )?(hear|come across|find|learn|come to know)\b/, (q, t) => !/\breferring (employee|person)\b|\bname of (the )?(person|employee) who referred\b|\bwho referred you\b/.test(t)],
  ["unknown", /\bconsecutive weeks\b|\binternship\/co-?op duration\b/],
  ["former_employers", /\bsecond most recent employer\b|\blist your work history\b|\bwork history\b/, (q, t) => !/discharged|resign|reason for leaving/.test(t)],

  // Links.
  ["linkedin", /\blinked ?in\b|\blinkedln\b/],
  ["github", /\bgithub\b/],
  ["website", /\b(portfolio|personal (web)?site|website)\b(?!.*\b(upload|file)\b)/, (q, t) => !LONG_TYPES.has(String(q.type)) && !/\b(academic|program|department|school|university|college|company|employer|organi[sz]ation)\b/.test(t)],

  // Work history.
  // WO-052 (sample C): "Current job title & company" asks for two things; the title alone is half an answer: asked.
  // WO-059 (sample H, Latitude AI): "Title Held at Most Recent Employer" is the title, not the employer.
  ["current_title", /\b(job )?title( held)?\b.{0,15}\b(at|with|for) (your )?(current|most recent|last|present) (employer|company|job)\b/],
  ["current_title", /^(current|your) (job )?title\b|\bcurrent or previous job title\b|^job title\b(?!.*second)/, (q, t) => !/\b(and|&)\s*(company|employer)\b|\b(company|employer)\b/.test(t)],
  ["unknown", /\bmay we contact your current employer\b/],
  ["notice_period", /\bnotice (period )?(to|would you need to provide to) your current employer\b|\bhow much notice\b/],
  ["current_employer", /\bcurrent (or most recent |\/ ?last )?(company|employer|organi[sz]ation)\b|\bmost recent employer\b|\bcurrent ?\/ ?(last|most recent) (company|employer)\b|\bwhere (are you currently|have you most recently|were you last) (employed|worked)\b|\bwho is your current or previous employer\b|^employer name\b|\bwhere have you most recently worked\b/, (q, t) => !/second|end date|discharged|related|relative|accenture|working on a project|\bnotice\b|non-?compete|non-?solicit|agreement|obligation|restrict/.test(t)],
  ["employment_status", /\bare you (currently )?employed\b|\bcurrent employment status\b/, (q, t) => !/\bemployed (by|with|at|in)\b|layoff|recall/.test(t)],
  ["years_experience", /\b(total|relevant)( professional)? years? of experience\b|\bhow many years of (relevant|professional|relevant professional) experience\b|\byears of experience do you have in a related field\b|\bexperience level do you have for this position\b|\bcombien d'années d'expérience\b|\btotal year of experience\b/, (q, t) => !/\bexperience\b[^?]*\b(in|with|using|doing|working in|working with)\s+(?!(a |the |your )?(related|similar|relevant|this|that|same)\b)[a-z]/.test(t)],

  // Availability.
  ["notice_period", /\bnotice period\b|\bhow much notice\b|\bpréavis\b|\blwd\b/],
  ["start_date", /\b(available|availability) to (start|begin)\b|\bstart date\b|\bwhen (can|could) you start\b|\bhow soon (are you able|can you) (to )?start\b|\bbest time to start\b|\bavailable to begin\b|\bdate available\b|\bcurrent availability to start\b|\bable to start within\b|\bavailable for full[- ]time (work|employment)\b/],
  ["employment_type", /\b(looking for|seeking|interested in) (full|part)-?time\b|\bfull-?time or part-?time (employment|role|position|work)\b|^are you looking for full-?time or part-?time/, (q, t) => !/employed by|worked (at|for)|employee of/.test(t)],

  // Pay.
  ["pay_range_ok", /\bcompensation (expectations )?(range )?(align|aligns)\b|\balign(s)? with (the posted range|my expectations)\b|\bpays a rate of\b.*\baccept\b/],
  ["unknown", /\b(salary|compensation|pay|ctc)\b.*\b(range|monthly|per month|a month|hourly|per hour|an hour|formatting|format)\b|\b(range|monthly|hourly)\b.*\b(salary|compensation|pay)\b|\$00/],
  ["current_compensation", /\bcurrent (ctc|compensation|salary|base)\b/],
  // "Your salary expectations (including currency)" asks the amount, with its currency; "what currency should we use?" asks the currency.
  ["salary_currency", /\bcurrency\b/, (q, t) => !/\b(including|include|with|in) (the |your |a )?currency\b|\bamount and( the)? currency\b|\bbonus\b|\bequity\b|\btotal (annual )?compensation\b/.test(t)],
  ["salary_expectation", /\bexpected (annual |base )?(ctc|compensation|salary)\b|\b(compensation|salary) (expectation|you expect|are you seeking|requirement)|\bdesired (salary|compensation)\b|\bideal annual compensation\b|\bexpected total annual compensation\b|\bcompensation you (expect|are seeking)\b|\bsalary expectations?\b/],

  // Education.
  // A graduate or doctoral GPA is not the undergraduate one: asked.
  ["unknown", /\b(graduate|doctorate|doctoral|master'?s) gpa\b|\bgpa \((graduate|doctorate)\)/, (q, t) => !/undergraduate/.test(t)],
  ["gpa", /\bgpa\b|\bgrade point average\b|\bdegree result\b/, (q, t) => !/grading system/.test(t)],
  ["test_scores", /\b(sat|act|gre|gmat|lsat) score\b/],
  // Greenhouse's education block names its fields with one word ("Degree", "School", "Discipline"): exact labels only,
  // never "degree in" or "school district" (WO-042, live Greenhouse forms).
  ["education_level", /^degree[\s*:]*$/],
  ["unknown", /\b(another|other|different|previous|former|maiden) name\b|\bunder (a |any )?(different|other) name\b/],
  ["school", /^(school|college|university)[\s*:]*$/],
  ["major", /^(discipline|field of study)[\s*:]*$/],
  ["education_level", /\bhighest (level of )?(education|degree)\b(?! in\b)|\blevel of education\b|\bwhich best describes your education\b|\bhigher education degree\b|\bhigh school diploma or equivalent\b/],
  ["major", /^major\b|\byour major\b|\bmajor ?\/ ?area\b|\barea of study\b|\bfield of study\b|\bhighest level degree in\b/],
  ["unknown", /\b(currently enrolled|enrolled in|current (degree )?program)\b/],
  ["graduation_date", /\bgraduation (date|year)\b|\bgraduat(e|ed|ion) date\b|\bexpected graduation\b|\bdiplôme\b|\bhave you graduated\b/],
  ["school", /\b(college|university|school)( name)?\b.*\b(attend\w*|name)\b|^school name\b|\bwhat (college|university|school)\b|\bwhich university\b|\bdans quelle école\b|\bpost-secondary education\b/, (q, t) => !/\bdegree\b|high school performance/.test(t)],

  // Skills.
  // "What other languages do you speak?" asks for languages besides the one a person always has: their language fact
  // alone does not answer it (WO-042, Welo Global).
  ["languages_other", /\b(other|additional|another|second|foreign)\b.{0,30}\blanguages?\b|\blanguages?\b.{0,30}\b(other than|besides|apart from|in addition to)\b/],
  // WO-048 round 2: "How would you rate your English proficiency?" names the language and asks its level.
  ["languages", new RegExp(`\\b(${LANGUAGE_NAMES.join("|")})\\b.{0,20}\\b(proficiency|fluency)\\b|\\b(proficiency|fluency)\\b.{0,30}\\b(${LANGUAGE_NAMES.join("|")})\\b`), (q) => !!q.options?.length],
  ["languages", /\bnative \w+ (translator|speaker)\b|\blanguages?\b.*\b(speak|fluent|proficien|communicate)|\b(fluent|fluency|proficien\w*) in\b|\bproficiency\b.*\blanguage|\blanguage (skill|proficiency)\b|\bspreek je\b|\bdo you speak\b|\bbusiness fluency\b|\bnative (level )?fluency\b|\blanguage\b.*\bproficiency\b/, (q, t) => !/\b(programming|coding|computer|scripting|query) languages?\b/.test(t)],
  ["drivers_license", /\bdriver'?s'? licen[cs]e\b/],
  // A license or ID number is never held (no identity digits); it is asked.
  ["unknown", /\b(licen[cs]e|permit|passport|social security|ssn|national id)( card)? number\b|\bexpiration date\b/],
  ["certifications", /\bcertification|\bcertified\b|\bcpa\b/, (q, t) => !/certify that|attestation/.test(t)],

  // Authorization.
  // WO-052: the countries of citizenship with when each was obtained: the dates are the person's own (Zoox).
  ["unknown", /\bcitizen\w*\b.*\b(when|obtained|dates?)\b/, (q, t) => /\bcountr(y|ies)\b/.test(t)],
  ["citizenship", /\bexport\b.*\bcountr(y|ies)\b.*\bcitizen(ship)?\b|\bcountr(y|ies) of citizenship\b/],
  ["us_person", /\bu\.?s\.? person\b|\bexport (controls?|compliance)\b|\bdeemed export\b|\bitar\b|\bexport licen/],
  ["us_person", /\bcitizen\b/, (q) => /asylee|refugee|protected individual/.test(opts(q))],
  // WO-052: "Only US Citizens will be considered" over "Yes, I am a US Citizen." and "Candidates must be US Citizens. Can
  // you meet this requirement?" ask whether the person is a U.S. citizen (Kitware, Juvare).
  ["citizenship", /\b(u\.?s\.?|united states) citizens\b/, (q, t) => (/citizen/.test(opts(q)) || /\bcan you meet this requirement\b|\bare you\b/.test(t)) && !/permanent resident|green card|lawful|asylee|refugee|national\b/.test(t)],
  // Eligibility to obtain a clearance is not holding one: "None held" never answers "eligible?" (WO-042, Anduril).
  // Willing to apply for a clearance is the person's to say; holding none does not answer it (WO-052, Kitware).
  ["clearance_eligibility", /\b(willing|able) (and able )?to (apply for|obtain|get)\b.*\bclearance\b/],
  // WO-059 (sample H): "are you able obtain", "do you meet the requirements to obtain and maintain a clearance": whether the
  // person could get one is theirs to say; holding none does not answer it.
  ["clearance_eligibility", /\b(able|ability|requirements?|qualify|qualified)\b.{0,12}\b(obtain|get|apply for)\b.{0,80}\bclearance\b/],
  ["clearance_eligibility", /\beligib\w*\b.{0,60}\bclearance\b|\bclearance\b.{0,30}\beligib/],
  ["security_clearance", /\bsecurity clearance|\bclearance\b(?!.*\bbackground\b)|\bts\/sci\b|\bdod\b.*\bclearance/, (q, t) => !/\bare you (currently |now )?(a )?(u\. ?s\.?|united states) citizen\b/.test(t)],
  // When the person's authorization ends is theirs to state; a "yes" to being authorized is not "no expiry".
  ["unknown", /\b(authori[sz]ation|visa|permit|status)\b.*\b(expir\w*|end date)\b|\bexpir\w*\b.*\b(authori[sz]ation|visa|permit)\b/],
  // WO-056: "Are you currently authorized to work in the US? We DO assist with visa sponsorship" asks the authorization.
  ["sponsorship", /\bsponsor(ship)?\b|\bvisa\b(?!.*\btransfer)|\bwork permit\b|\bimmigration case\b|\bright to work support\b|\bnonimmigrant\b/, (q, t) => (!/^(are|is) you (currently |now )?(legally )?authori[sz]ed to work\b[^?]*\?/.test(t) || /^[^?]*\bsponsor/.test(t)) && !authorizationAsked(t)],
  ["citizenship", /\bcitizen(ship)?\b|\bnationality\b|\bpermanent resident\b|\bcitizenship ?\/ ?employment eligibility\b/, (q, t) => !/renounced|\bwhen\b|obtained|\bdates?\b/.test(t)],
  ["unknown", /\bat[- ]will\b/],
  ["work_authorization", /\b(legally )?(authori[sz]ed|eligible|entitled) (to work|for employment)\b|\bright to work\b|\bunrestricted right\b|\bproof of authorization\b|\beligibility to work\b|\bpermiso de trabajo\b|\bwork authori[sz]ation\b|\blegal right to work\b|\bverify (your|both your) identity and|\bauthori[sz]ation to work\b/],
  ["over_18", /\b(at least |over (the age of )?|)18( years)?( of age| or older| jaar)\b|\b18 jaar\b|\bunder 18\b|\bover the age of 18\b|\bat least 18\b/],

  // A generic label over a disclosure's own list ("Please select one of the options below:" above veteran classes) is that
  // disclosure (WO-048, Workday's Voluntary Disclosures).
  ["eeo", /^please (select|check|choose) (one|any|all) of the (options|boxes|following)\b/, (q) => /veteran|disabilit|gender|hispanic|latino|\brace\b|ethnicit/.test(opts(q))],
  ["eeo", /\btransitioning service member\b|\bveteran\b|\bdisability\b|\bgender\b|\bethnicity\b|\brace\b|\bhispanic\b|\blatin[oax]\b|\bsexual orientation\b|\bgender identity\b|\btransgender\b|^tu es\b/],

  // Legal attestations.
  // WO-052: the person's "no" to criminal history is about convictions. Drug use, a court order, a commitment, a
  // discharge, a dishonorable discharge or a regulator's bar are other questions, each the person's own: asked.
  ["unknown", /\bunlawful user\b|\baddicted\b|\bmental (defective|institution)\b|\bdishonorabl\w*\b|\bdischarged\b|\basked to resign\b|\bcourt order\b|\brenounced\b|\bprohibited possessor\b|\bfirearms licensee\b|\bprohibited or restricted\b/],
  ["criminal_history", /\bconvicted\b|\bfelony\b|\bcrime\b|\bindictment\b|\bfugitive\b|\billegally or unlawfully\b/],
  ["government_employment", /\b(u\.?s\.? )?government (\(|employee|employment|or military)|\bgovernment employee\b|\barmed forces\b|\breserves or the national guard\b|\bstate-owned\b|\bus government employment\b|\bprior us government\b/],
  ["non_compete", /\btype of obligation\b|\bnon-?compete\b|\bnon-?solicit|\brestrictive covenant|\bpost-employment obligation|\boutside (employment|business)|\bcontractual obligations\b|\bobligations, if any\b|\bemployment agreement\b/, (q, t) => !/non-?disclosure|confidentiality agreement|confidential (information|agreement)|outside (employment|business)|consult|side business|board roles?|advisory|non-?solicit|restrictive covenant|post-employment restriction/.test(t)],
  // A yes to a background check is not a yes to a drug test, a reference check or being monitored at work (WO-052).
  ["background_check_ok", /\bbackground (check|investigation)\b/, (q, t) => !/drug|substance|reference check|monitor/.test(t)],

  // Consent.
  // WO-058: sharing the application with another company (an affiliate, a sister airline) is the person's own call.
  ["unknown", /\b(consent|agree|authori[sz]e|permit|allow)\b.{0,40}\bshar(e|ing)\b.{0,80}\b(with|to)\b/],
  ["sms_opt_in", /\b(text|sms|whatsapp)\b.*\b(message|communication|update|opt|consent|contact)|\bopt[- ]in to (text|receive text)|\bsms consent\b|\bcontact you by text\b/],
  ["marketing_opt_in", /\bnewsletter|\btalent community\b|\bother job openings\b|\btraining opportunities and courses\b|\bstay connected\b|\bmarketing (communications?|e-?mails?|updates)\b|\brecruitment marketing\b/],
  ["ai_policy_ack", /\bai policy\b|\buse (of )?ai (tools )?to\b.*\b(research|prepare|refine|application)|\bplagiarism\b|\bown words\b|\bembrace ai\b/, (q, t) => !LONG_TYPES.has(String(q.type)) && !BEYOND_CONSENT.test(t + " " + opts(q))],
  ["certify_true", /\bcertif(y|ication)\b.*\b(true|accurate|correct|complete)|\btrue and (complete|correct)|\baccurate to the best\b|\bapplicant'?s? statement\b/, (q, t) => !BEYOND_CONSENT.test(t + " " + opts(q)) && !/^applicant'?s? statement:?$/.test(t)],
  // A bare heading ("Certification & Attestation", "Affirmation") does not say what is attested: the person reads it
  // (WO-052, IEM).
  ["privacy_ack", /\bprivacy\b|\bpersonal (data|information)\b|\bdata (protection|processing)\b|\bconsumer privacy act\b|\breview the linked document\b|\bnotify you that personal data\b/, (q, t) => !BEYOND_CONSENT.test(t + " " + opts(q)) && (!/review the linked document/.test(t) || /privacy/.test(opts(q)))],
  // A data-use consent beyond the standing one (reuse, sharing): the person's own, never read as a screen (WO-052, Agoda).
  ["unknown", /\b(personal data|your data|data from your application)\b/],

  // The application and this employer.
  ["referral", /\breferr(ed|al|ing)\b/, (q, t) => !/government official|public official|politically exposed|public function|personally know|know (anyone|someone|a current)|acquainted/.test(t)],
  ["relative_here", /\b(relatives?|family members?|spouses?|related to|in-laws|anyone you live with)\b/, (q, t) => !/friend|household|supplier|vendor|partner|personal (or social )?relationship|social relationship|\bcontacts?\b|practic|profession|occupation|health ?care|purchase|customer|official/.test(t)],
  ["applied_before", /\b(applied|interviewed) (to|for|at|with)?\b.*\b(before|past|previously|within the past)\b|\bhave you (ever )?(previously )?(applied|interviewed)\b|\bpast or existing job application\b/],
  // WO-052: "Are you currently or have you ever been a One Medical Employee?", "Are you now or have you ever been a Penumbra
  // employee?", "Are you a current IEM employee?". A temporary, agency or contract role is not on an employer list: asked.
  ["worked_here_before", /\b(currently|now) or have you ever been (a |an )?[^?]{1,60}\bemployee\b|\bare you (a |an )?current [^?]{1,60}\bemployee\b/, (q, t) => !/temporar|\btemp\b|agency|vendor|contract|consult|intern|government|relative|family/.test(t)],
  ["worked_here_before", /\bhave you previously been (employed|working|engaged)\b.*\b(by|for|at|with)\b|\b(worked|employed|employee|contractor|work)\b.*\b(for|at|by|with|of)\b.*\b(before|past|previously|currently|now or have you ever|ever been|in any capacity|history)\b|\bemployment history\b|\bhistory with\b|\bhave you (ever )?(been )?(previously )?(employed|worked)\b.*\b(by|for|at|with)\b|\bwere you (ever )?(employed|an employee)\b.*\b(by|of|at)\b|\bhave you worked (at|for|with)\b|\bare you (a |an )?(current|former) (employee|contractor)|\bcurrently (an |a )?(intern|employee|contractor)\b|\bi am a (currently an|former) employee\b|\bcurrent employee of\b|\bcurrent contractor for\b|\bare you currently employed by\b|\bpresently employed by\b|\bwork for a member firm\b|\bex-employee\b|\b(were|are|have) you (ever )?(been )?(a |an )?(previous|former|prior|past) (employee|contractor|worker|intern)\b.*\b(of|at|for|with|by)\b/, (q, t) => !/government|relative|family|second most recent|reason for leaving|end date|how many|number of|project|client|agency|vendor|third[- ]party|partner|reseller|customer/.test(t + " " + opts(q))],
  // WO-058: work through an agency, a vendor or a third party for this employer is not on the person's employer list.
  ["unknown", /\b(employed|worked|work|services)\b.*\b(by|for|with|through|to)\b.*\b(staffing|agency|vendor|third[- ]party|contractor|partner|reseller|customer)\b/],
  ["how_heard", /\bhow did you (first |initially )?(hear|come across|find|learn|come to know)\b|\bwhere did you (hear|find)\b|\bhow (did you )?hear\b|\bcomment as-tu entendu\b|\bwhere you heard\b|\bheard about this position\b|\bhow you heard\b|^(applicant |candidate |job |application )?source\b(?!.*referral)|\b(applicant|candidate|application|job|referral) source\b/, (q, t) => !/\breferring (employee|person)\b|\bname of (the )?(person|employee) who referred\b|\bwho referred you\b/.test(t)],
  // "Available on request" answers only a question about references, never a request to list them (WO-052).
  ["references", /\breferences?\b(?!.*\b(cv|resume)\b)/, (q, t) => !/\b(list|enter|provide|names?|emails?|phone|contact|rationale|evidence|make reference|reference check)\b/.test(t)],

  // This job's screens.
  // Before the other screens: a question that names an essential function but asks about commuting is about commuting.
  // Whether the person lives within commuting distance of this job's office depends on where that office is, which their
  // stated yes to working on site does not say: asked (WO-042, Snowflake).
  // WO-048: "Are you local to Chicago, IL or willing to relocate?" asks two things at once; neither fact alone answers it.
  // WO-052: a plan to work remotely is not the person's yes to the office read backwards (Stripe).
  ["unknown", /\b(plan|intend|want|prefer|wish|like) to work remote(ly)?\b/],
  // WO-052: needing relocation, limits on relocating and knowing a role requires it are not the person's willingness.
  ["unknown", /\brequire (relocation|relocating|you to relocate)\b.*\?$|\bwill you require relocation\b|\brelocation (limitation|restriction)s?\b|\bare you aware\b/],
  // An in-person interview, many trips or a share of time traveling is not the person's general yes to the office or to travel.
  ["unknown", /\bin-?person\b.{0,40}\binterview|\binterview\b.{0,40}\bin-?person\b|\b\d+\s*%\s*(of )?travel|\btravel\b.{0,40}\b\d+\s*%|\b\d+\s*-\s*\d+ times a year\b|\binternational(ly)? travel/],
  ["unknown", /\b(are|do) you (currently )?(local to|live in|living in|based in|reside in|near) (?!or\b)[a-z].*\bor\b.*\brelocat|\brelocat\w*\b.*\bor\b.*\b(local to|live in|living in|based in|reside in) (?!or\b)[a-z]/],
  // WO-058: "Where are you located currently? Are you able/willing to relocate or commute?" asks both; neither fact alone.
  ["unknown", /\bwhere (are|do) you\b[^?]*\b(located|live|based|reside)\b[^?]*\?.*\b(relocat|commut)/],
  ["job_commute", /\bcommut\w*\b.*\b(distance|range)\b|\breside within\b|\bwithin \d+ (miles|km|kilometers)\b|\b(live|reside|located|based) (near|close to|nearby)\b|\bwithin (a )?commut/, (q, t) => !/\bif you (do not|don'?t) (currently )?(live|reside)\b/.test(t)],
  ["essential_functions", /\bessential functions?\b|\bwith or without (a )?reasonable accommodation/],
  ["meets_qualifications", /\bmeet (each of |all )?(the )?(basic |essential |required )?qualifications\b|\bread the required qualifications\b/],
  ["job_physical", /\blift(ing)?\b.*\b(lbs?|pounds?)\b|\bstand(ing)? for\b|\bclimb\b|\bmedical waste\b/],
  ["job_schedule", /\bovertime\b|\bweekends?\b|\bshift\b|\bus (time ?zone|pst hours)\b|\bdays and times\b|\bweekend\b|\bin het weekend\b|\bus shift\b|\bpst\b/],
  ["job_travel", /\btravel\b(?! (company|inc|group|corp|holdings))/, (q, t) => (!/open to travel\?$|^what % of travel/.test(t) || /\brequires?\b/.test(t)) && !/\bin-?office\b|\bhybrid\b|\bon-?site\b|\bfully remote\b|\bwork(ing)? (fully )?remote(ly)?\b|\bdays (a|per) week\b/.test(t)],
  ["travel_ok", /\bopen to travel\b|\bwhat % of travel\b|\bwilling to travel\b/, (q, t) => !/\bin-?office\b|\bhybrid\b|\bon-?site\b|\bdays (a|per) week\b/.test(t)],
  ["job_relocation", /\brelocat/, (q, t) => /\b(this position|this role|office|headquarters|hq)\b/.test(t) || /relocate (to|before)/.test(opts(q))],
  ["job_relocation", /\brelocat\w*\b.*\b(to|in)\b [a-z]/, (q, t) => !/^are you (open|willing) to relocat\w*( if needed)?\??$/.test(t)],
  ["relocation", /\brelocat/],
  ["job_onsite", /\bon-?site\b|\bin-?office\b|\bin the office\b|\bin office\b|\bhybrid\b|\bin[- ]person\b|\bcommut|\bdays (a|per) week\b|\boffice (location|days)|\bfloat to\b|\breport to the office\b|\bwork from our\b|\bwork remotely\b|\bremote opportunities\b|\banchor days\b|\bwithin \d+ miles\b|\breside within\b|\bmeet in person\b/],
  ["job_location_choice", /\bwhich location are you applying\b|\btop location preference\b|\bcountries you anticipate\b|\bcities are you available\b|\btop 3 .* locations\b|\bpreferred location\b/],
  ["essay_why_company", WHY, (q) => LONG_TYPES.has(String(q.type))],
  ["essay_experience", DESCRIBE, (q) => LONG_TYPES.has(String(q.type))],
  ["job_experience", /\b(experience|years?)\b.*\b(with|in|using|of|building|teaching|writing)\b|\bhave you (built|led|used|worked on|personally|had hands-on|independently)\b|\bdo you have (a minimum|at least|experience|any (relevant )?experience|hands-on|working knowledge)\b|\bare you comfortable\b|\bwhich best describes\b|\bhow many\b.*\b(products|years)\b|\bstacks\b|\bselect all that apply\b|\bskills\b/, (q, t) => !LONG_TYPES.has(String(q.type)) || yesNoOnly(q)],

  // Written answers.
  ["essay_why_company", WHY, (q) => LONG_TYPES.has(String(q.type)) || q.type === "text" || q.type === "input_text"],
  ["essay_experience", DESCRIBE, (q) => LONG_TYPES.has(String(q.type)) || q.type === "text"],
  ["essay_other", /\?|\bwhat\b|\bhow\b/, (q) => LONG_TYPES.has(String(q.type))],
];

export function mapQuestion(q: Question): MappedQuestion {
  const t = norm(q.label);
  for (const [fact, test, when] of RULES) {
    if (!test.test(t)) continue;
    if (when && !when(q, t)) continue;
    return { fact, kind: kindOf(fact), why: `${fact}: ${test.source.slice(0, 60)}` };
  }
  return { fact: "unknown", kind: "unknown", why: "no rule" };
}
export const RULE_COUNT = RULES.length;

// A question that asks for an identity number, a bank or card number or a secret is never asked by text, stored or held:
// the person types it on the form (standing rules: no full ID or card numbers, no passwords, anywhere). The engine
// already stops on identity numbers before planning (scripts/apply.ts IDENTITY_NUMBER); this is the texting side's own.
export const NEVER_BY_TEXT =
  /social security|\bssn\b|passport (number|no\b)|driver'?s licen[cs]e (number|no\b)|national (id|insurance) number|\btax(payer)? id|\bitin\b|alien (registration )?number|\ba-number\b|bank account|routing number|card number|\bpassword\b|\bpin\b/i;

// 64-bit FNV-1a of the words, as 16 hex digits: a key for any language's wording.
function h16(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s)) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16).padStart(16, "0");
}
// How far one answer may travel (ask once). A fact about the person they have not stated goes to every employer, but
// only when the answer is a value of that fact: a yes to "Are you a U.S. citizen?" is not a citizenship, and a yes to
// "authorized to work in the US?" must never answer the same question about Canada, so a yes/no question about a fact
// that is not itself a yes or no is kept to its wording. A legal statement, a consent, years with a named tool or an
// unmapped question: the same wording only. An essay, a question about this job (its offices, schedule, pay, duties),
// one computed from this employer, or a fact whose stated value did not fit this form's options: this posting only.
const YES_NO_ASKED = /^(are|do|does|have|has|will|would|can|could|is|did|were|was|may|should)\b/;
export const factType = (fact: string): string => (FACTS[fact] as any)?.type ?? "text";
function yesNoAsked(q: Question): boolean {
  if (/checkbox|boolean/.test(String(q.type))) return true;
  if (q.options?.length) return q.options.every((o) => /^(yes|no)\b/i.test(String(o.label).trim()));
  return YES_NO_ASKED.test(norm(q.label));
}
// Work rights are the person's for the country they stated (WO-052, WO-053). An answer to work rights somewhere else
// is never kept as their fact: "...in the country where this job is located" is that posting's alone, and "...in the
// UK?" travels only with its own wording, which names the country.
export const FOREIGN = /\b(canad(a|ian)|united kingdom|\buk\b|britain|british|england|english employment|scotland|ireland|irish|german[y]?|deutschland|france|french|spain|spanish|españa|portugal|portuguese|italy|italian|italia|netherlands|nederland|dutch|belgi(um|an)|switzerland|swiss|austria\w*|swed(en|ish)|norw(ay|egian)|denmark|danish|finland|finnish|poland|polish|czech|hungar\w*|romania\w*|greece|greek|israel\w*|india|indian|china|chinese|hong kong|taiwan\w*|japan\w*|korea\w*|singapore\w*|australia\w*|new zealand|mexic\w*|méxico|brazil\w*|brasil|argentin\w*|colombia\w*|chile\w*|peru\w*|philippine\w*|filipino|indonesia\w*|malaysia\w*|vietnam\w*|thai(land)?|uae|united arab emirates|dubai|saudi|qatar\w*|south africa\w*|nigeria\w*|kenya\w*|egypt\w*|turk(ey|ish)|european union|\beu\b|europe\w*|emea|apac|latam)\b/i;
export const NAMES_US = /\bu\.?s\.?a?\b|united states|\bamerica\b/i;
export const AUTH_FACTS = new Set(["work_authorization", "sponsorship", "us_person"]);
// WO-053: work rights "in the country where this job is located" (or "...in which you are applying") are the person's US
// ones only when the posting's own location is in the US; abroad or unsettled, asked.
export const RELATIVE_PLACE = /\b(country|location)\b.{0,60}\b(this|the) (job|role|position|opportunity|vacancy)\b|\b(country|location)\b.{0,40}\b(you are|you're|you have been|you've been|are you) apply|\b(country|location) (in which|to which|for which|where) you (are )?apply|\bstated location of this role\b|\bin this country\b/i;
export function answerKey(q: Question, jobId: string, o: { haveFact?: boolean; here?: boolean } = {}): string {
  const m = mapQuestion(q);
  const words = norm(q.label);
  const job = `job:${h16(`${jobId}\n${words}`)}`, wording = `label:${h16(words)}`;
  if (m.kind === "fact") {
    // WO-055: where the planner would not use the person's fact here (a job abroad, a question beyond what the fact says;
    // career_apply.ts factStaysHere), the answer is this posting's, never the person's fact or a wording that travels.
    if (o.here) return job;
    if (AUTH_FACTS.has(m.fact) && RELATIVE_PLACE.test(q.label)) return job;
    if (AUTH_FACTS.has(m.fact) && FOREIGN.test(q.label) && (m.fact === "sponsorship" || !NAMES_US.test(q.label))) return wording;
    if (o.haveFact) return job;
    return factType(m.fact) === "yesno" || !yesNoAsked(q) ? `fact:${m.fact}` : wording;
  }
  return m.kind === "essay" || m.kind === "derived" || (m.kind === "screen" && m.fact !== "job_experience") ? job : wording;
}
