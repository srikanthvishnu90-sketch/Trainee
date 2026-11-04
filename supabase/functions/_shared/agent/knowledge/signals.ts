// Situation signals: what a piece of the person's own words says about where they are and what they are asking. Pure,
// deterministic, no model. A signal is a tag ("stage:freshman", "topic:cold_email", "ctx:international"); the Person Context
// Pack carries them with where each came from, and retrieval (retrieve.ts) picks playbooks by them. A signal is only ever a
// pointer to the right method: it never becomes a fact about the person (that takes their confirmed facts, D-007).

// One level group is exclusive (a person is in one of these at a time); the rest are additive overlays or topics.
export const LEVELS = ["freshman", "sophomore", "junior", "senior", "new_grad", "grad_student", "mid_career"] as const;
export type Level = typeof LEVELS[number];

const JOBISH = "(?:at|on|in|of) (?:my |the |a )?(?:job|work|role|team|company|career|position|internship)";
const R = (s: string) => new RegExp(s, "i");

// Stage-like signals found in text. `levels` are tried in order; the first that matches names the level.
const LEVEL_RX: [Level, RegExp][] = [
  ["freshman", R(`\\bfreshm[ae]n\\b|\\bfirst[- ]year\\b(?! ${JOBISH})(?! (?:analyst|associate|developer|engineer|teacher|nurse|manager))|\\b1st[- ]year\\b`)],
  ["sophomore", R(`\\bsophomore\\b|\\bsecond[- ]year\\b(?! ${JOBISH})(?! (?:analyst|associate|developer|engineer|teacher|nurse|manager|master|mba|phd))|\\b2nd[- ]year\\b`)],
  ["junior", R(`\\b(?:i'?m|i am|rising|as a|a) junior\\b(?! (?:analyst|developer|engineer|designer|role|position|associate|level|dev|accountant|marketer|writer))|\\bjunior (?:year|in college|at \\w+ (?:university|college)|studying)|\\bthird[- ]year (?:student|of (?:college|uni\\w*|undergrad\\w*))|\\b3rd[- ]year\\b`)],
  ["senior", R(`\\bsenior (?:year|in college|studying)|\\b(?:i'?m|i am|rising) (?:a )?senior\\b(?! (?:analyst|developer|engineer|manager|role|position|level|designer|associate))|\\bfinal[- ]year\\b|\\bfourth[- ]year\\b|\\b4th[- ]year\\b|\\bgraduat(?:e|ing) (?:in|this|next|soon|by)\\b|\\bclass of 20\\d\\d\\b`)],
  ["new_grad", R(`\\bnew[- ]grad\\b|\\brecent(?:ly)? grad\\w*|\\bjust graduated\\b|\\bgraduated (?:in|last|this|a few|\\d+ months?)\\b|\\bfresh out of (?:college|school|uni\\w*)`)],
  ["grad_student", R(`\\bmaster'?s\\b|\\bmasters (?:program|degree|student)\\b|\\bphd\\b|\\bdoctoral\\b|\\bgrad(?:uate)? (?:student|school|program)\\b|\\bmba\\b`)],
];

const OVERLAY: [string, RegExp][] = [
  ["stage:career_changer", R(`\\bcareer (?:chang\\w+|switch\\w*|pivot\\w*)|\\b(?:chang\\w*|switch\\w*|pivot\\w*|transition\\w*) (?:careers?|fields?|industr\\w+|into (?:tech|data|product|design|marketing|finance|software|ux|a new|something)\\b)|\\bpivot(?:ing)? (?:to|into)\\b|\\b(?:moving|switching|transition\\w*|pivot\\w*|changing) from [\\w ]{2,25} (?:to|into)\\b|\\bswitch(?:ing)? to (?:a |an )?\\w+|\\bshould i (?:switch|change careers|pivot)\\b|\\bwhat else can i do\\b`)],
  ["stage:bootcamp", R(`\\bbootcamp\\b|\\bself[- ]taught\\b|\\bteaching myself\\b|\\btaught myself\\b`)],
  ["stage:returning", R(`\\breturning to work\\b|\\bback to work\\b|\\breturn(?:ing)? to the workforce\\b|\\bstay[- ]at[- ]home\\b|\\b(?:maternity|parental|family|caregiving|caregiver) (?:leave|break)\\b|\\bout of the workforce\\b|\\bwas (?:home )?raising\\b|\\btook (?:\\w+ )?years? off\\b|\\bafter (?:\\d+|several|a few|many) years (?:at home|away|off|out)|\\bwas home with\\b|\\bhome with (?:my )?(?:kids|children)\\b|\\bat home with\\b|\\bcaring for (?:a |my )?(?:parent|mother|father|child|kids|family)\\b|\\bhave been out of (?:the )?work\\w*|\\bwhile my (?:kids|children) (?:are|is) in school\\b`)],
  ["stage:gap", R(`\\bgap year\\b|\\bgap (?:in|on) my (?:resume|cv|work history)\\b|\\bemployment gap\\b|\\btook (?:a )?(?:year|time|\\d+ months?|a break|some time) off\\b|\\bunemployed for\\b`)],
  ["stage:laid_off", R(`\\blaid off\\b|\\blayoffs?\\b|\\bwas let go\\b|\\bgot let go\\b|\\bdownsiz\\w+|\\bposition (?:was )?eliminated\\b|\\bredundan(?:t|cy)\\b|\\bwas fired\\b|\\bgot fired\\b`)],
  ["stage:no_experience", R(`\\bno (?:work |job |relevant |real |professional )?experience\\b|\\bnothing on my resume\\b|\\bnever (?:had|held) a job\\b|\\bno internships?\\b|\\bzero experience\\b|\\bempty resume\\b|\\bresume is (?:basically |pretty |totally |just )?(?:empty|blank)\\b`)],
  ["stage:military", R(`\\bveteran\\b|\\bmilitary\\b|\\bformer (?:army|navy|marine|air force)\\b|\\bcoast guard\\b|\\bseparating from (?:the )?(?:army|navy|service)\\b|\\b(?:army|navy|marines?|air force|national guard)\\b`)],
  ["ctx:international", R(`\\binternational (?:freshm[ae]n|sophomore|junior|senior|students?|applicant)\\b|\\b(?:work|job|move|relocat\\w+) (?:in|to) the (?:us|usa|u\\.s\\.|united states)\\b|\\bf-?1\\b|\\bopt\\b|\\bcpt\\b|\\bh-?1b\\b|\\bvisa\\b|\\bwork (?:authorization|permit)\\b|\\bsponsor\\w*\\b|\\bgreen card\\b|\\bstudy permit\\b|\\bi-?20\\b|\\bnot a (?:us|u\\.s\\.) citizen\\b`)],
  ["topic:sponsorship", R(`\\bsponsor\\w*\\b|\\bh-?1b\\b|\\bwork (?:authorization|permit)\\b|\\bneed (?:a )?visa\\b|\\bopt (?:ends|ending|expires?|expiring|runs out)\\b|\\b(?:visa|status|authorization) (?:ends|expires|runs out)\\b|\\b(?:work|job|move|relocat\\w+) (?:in|to) the (?:us|usa|u\\.s\\.|united states)\\b`)],
  ["ctx:nontarget", R(`\\bnon[- ]?target\\b|\\bnot a target\\b|\\bcommunity college\\b|\\bsmall (?:college|school)\\b|\\bno[- ]name (?:school|college)\\b|\\bunknown (?:school|college)\\b|\\btransfer(?:red)? (?:student|from)\\b|\\bnot (?:an )?ivy\\b|\\bnot a (?:top|prestigious)\\b|\\bnever recruit\\w* (?:from|at)\\b|\\bdoesn'?t recruit\\b|\\bisn'?t (?:known|a target)\\b|\\bnot known for\\b|\\bnobody has heard\\b|\\bschool nobody\\b`)],
  ["ctx:first_gen", R(`\\bfirst[- ]gen\\w*\\b|\\bfirst in my family\\b|\\bdon'?t know anyone\\b|\\bno (?:connections|contacts|network)\\b|\\bno one in my family\\b|\\bdon'?t have (?:a |any )?(?:network|connections)`)],
  ["ctx:relocation", R(`\\brelocat\\w+|\\bmov(?:e|ing) to\\b|\\bout of state\\b`)],
  ["ctx:remote", R(`\\bremote\\b|\\bwork from home\\b|\\bwfh\\b`)],
  ["ctx:research", R(`\\bresearch\\b|\\bprofessors?\\b|\\blabs?\\b|\\bthesis\\b`)],
  ["ctx:small_firm", R(`\\bsmall(?:er)? (?:firms?|companies|company|businesses|employers|teams?|shops?|startups?|orgs?|organizations?)\\b|\\blocal (?:firms?|businesses|companies)\\b|\\bboutique\\b|\\b(?:\\d{1,3}|\\w+)[- ]person (?:company|firm|studio|shop|startup|team)\\b`)],
  ["ctx:startup", R(`\\bstart-?ups?\\b`)],
  ["ctx:bigco", R(`\\b(?:big|large) (?:tech|compan(?:y|ies)|firms?|corporations?|banks?|employers?)\\b|\\bfaang\\b|\\bbig (?:four|4)\\b|\\bfortune 500\\b|\\bbulge bracket\\b`)],
  ["ctx:portfolio_field", R(`\\b(?:design|designer|developer|software|web dev|coding|programming|data (?:science|analy\\w+)|writing|writer|photograph\\w+|video|ux|machine learning|engineer\\w*)\\b`)],
  ["ctx:low_confidence", R(`\\bnot good enough\\b|\\bimpost\\w+|\\bnervous\\b|\\banxious\\b|\\bscared\\b|\\bafraid\\b|\\bbehind (?:everyone|my peers|others|my classmates)\\b|\\bhopeless\\b|\\bgive up\\b|\\bgiving up\\b|\\bno confidence\\b|\\binsecure\\b|\\bdoubt myself\\b|\\bfeel (?:like )?(?:a )?(?:failure|stupid|dumb|worthless)\\b|\\bembarrass\\w+|\\bfraud\\b|\\bfeel (?:so |really |very )?behind\\b|\\bhands shake\\b|\\b(?:all )?my (?:friends|classmates|peers) (?:already )?(?:got|have)\\b|\\beveryone (?:else |in my class )?(?:already )?(?:has|got)\\b`)],
  ["ctx:overwhelm", R(`\\boverwhelm\\w*|\\bburn(?:ed|t)? ?out\\b|\\bexhausted\\b|\\bdon'?t know where to start\\b|\\bstressed\\b|\\btoo much\\b|\\bpanick\\w*|\\bfreaking out\\b|\\bidk what\\b|\\bdon'?t know what i'?m doing\\b|\\bno idea what\\b`)],
  ["ctx:public_sector", R(`\\bgovernment\\b|\\bfederal\\b|\\bpublic sector\\b|\\bcivil service\\b|\\bstate (?:job|agency)\\b|\\bcity (?:job|government)\\b`)],
  ["ctx:nonprofit", R(`\\bnon-?profits?\\b|\\bngo\\b|\\bcharity\\b`)],
];

const TOPIC: [string, RegExp][] = [
  ["topic:internship", R(`\\bintern(?:ship|ships|s)?\\b|\\bco-?op\\b|\\bsummer (?:job|program|role|position)s?\\b`)],
  ["topic:cold_email", R(`\\bcold (?:email|message|outreach|dm|call)\\w*|\\bemail (?:a |the |some )?(?:founder|professor|ceo|recruiter|manager|owner)s?\\b|\\bwho (?:to |should i |do i )email\\b|\\bhow (?:do|should|can) i (?:email|contact|reach out|approach)\\b|\\breach out to\\b`)],
  ["topic:referral", R(`\\breferr?als?\\b|\\brefer me\\b`)],
  ["topic:networking", R(`\\bnetwork(?:ing)?\\b|\\bconnections?\\b|\\balumni\\b|\\bmentors?\\b|\\bmeet people\\b|\\bcoffee chats?\\b|\\binformational\\b`)],
  ["topic:informational", R(`\\binformational\\b|\\bcoffee chats?\\b|\\bpick (?:their|someone'?s) brain\\b`)],
  ["topic:resume", R(`\\bresume\\b|\\bcv\\b|\\bcover letter\\b`)],
  ["topic:interview", R(`\\binterview\\w*\\b|\\bphone screen\\b|\\brecruiter call\\b`)],
  ["topic:behavioral", R(`\\bbehaviou?ral\\b|\\btell me about a time\\b|\\bstar (?:method|format)\\b|\\b(?:failure|weakness|conflict|strength) (?:question|story)\\b|\\bask(?:s|ed)? (?:me )?about a (?:failure|time|conflict|weakness)\\b`)],
  ["topic:technical", R(`\\btechnical (?:interview|screen|round|test)\\b|\\bleetcode\\b|\\bcoding (?:interview|challenge|test)\\b|\\bcase (?:interview|study)\\b|\\btake[- ]home\\b|\\bwhiteboard`)],
  ["topic:offer", R(`\\boffers?\\b(?! to help)|\\bacceptance deadline\\b`)],
  ["topic:negotiation", R(`\\bnegotiat\\w+|\\bcounter(?:offer| offer)?\\b|\\bask for more\\b|\\bsalary expectations?\\b|\\bhow much (?:should i ask|to ask)\\b`)],
  ["topic:rejection", R(`\\brejected\\b|\\brejections?\\b|\\bturned me down\\b|\\bdidn'?t get (?:the |an? )?(?:job|offer|internship|interview|role)\\b|\\bnot selected\\b|\\bnot moving forward\\b`)],
  ["topic:ghosted", R(`\\bghost(?:ed|ing)?\\b|\\bno (?:response|reply|answer)s?\\b|\\bnever (?:heard|got) back\\b|\\bhaven'?t heard back\\b|\\bno one (?:replies|responds)\\b|\\bradio silence\\b|\\b(?:and|then) nothing\\b|\\bno word\\b|\\bnever (?:replied|responded)\\b|\\bstopped (?:replying|responding)\\b`)],
  ["topic:follow_up", R(`\\bfollow[- ]?up\\b|\\bthank[- ]you (?:note|email)\\b|\\bcheck(?:ing)? in\\b`)],
  ["topic:portfolio", R(`\\bportfolio\\b|\\bprojects?\\b|\\bgithub\\b|\\bwhat (?:should|can) i (?:build|make)\\b`)],
  ["topic:volume", R(`\\b(?:\\d{2,4}|hundreds?|dozens?) (?:of )?(?:applications?|jobs|roles)\\b|\\bmass[- ]apply\\b|\\bapply to everything\\b|\\bspray\\b|\\beasy apply\\b|\\b\\d{2,4}\\+? (?:people|contacts|recruiters|companies|employers)\\b|\\bmessage everyone\\b|\\bmass[- ]message\\b|\\bhow many (?:jobs|applications|roles) (?:should|do|can)\\b`)],
  ["topic:stalled", R(`\\bnot getting (?:any )?(?:interviews|responses|replies|callbacks)\\b|\\bno (?:interviews|callbacks)\\b|\\bsearch (?:is )?(?:stalled|not working)\\b|\\bnothing is working\\b|\\bhaven'?t (?:gotten|had) any (?:interviews|responses|callbacks)\\b|\\bapplied to \\d+\\b[^.]{0,40}\\b(?:nothing|no |zero)|\\b\\d+ rejections?\\b|\\bsomething wrong with my\\b|\\bwhat am i doing wrong\\b|\\bno interviews at all\\b`)],
  ["topic:confidence", R(`\\bnot good enough\\b|\\bimpost\\w+|\\bbehind (?:everyone|my peers|others|my classmates)\\b|\\bno confidence\\b|\\bdoubt myself\\b|\\bfeel (?:so |really |very )?behind\\b|\\bfraud\\b|\\b(?:all )?my (?:friends|classmates|peers) (?:already )?(?:got|have)\\b|\\beveryone (?:else |in my class )?(?:already )?(?:has|got)\\b|\\bhopeless\\b|\\bgive up\\b|\\bgiving up\\b|\\bfeel (?:like )?(?:a )?(?:failure|stupid|dumb|worthless)\\b`)],
  ["topic:choosing", R(`\\b(?:vs\\.?|versus)\\b|\\bor (?:a |an |the )?(?:big|large|bigger|stay|go|take|accept)\\b|\\bshould i (?:take|accept|choose|go|switch|leave|quit|pursue|do|stay)\\b|\\bwhich (?:is|one is) better\\b|\\bworth it\\b|\\bbig tech or\\b|\\bstartup or\\b|\\bis (?:that|it|this) bad\\b|\\bbootcamp or\\b`)],
  ["topic:grad_school", R(`\\b(?:grad(?:uate)? school|master'?s|masters|phd|mba|law school|med school)\\b[^.?]{0,60}\\b(?:or|vs|worth|should)\\b|\\bworth (?:it )?(?:to )?(?:get|doing|pursuing) (?:a |an )?(?:masters?|master'?s|phd|mba)\\b|\\bback for (?:a |my )?[\\w ]{0,15}degree\\b|\\bgo(?:ing)? back to school\\b|\\b(?:mba|phd) or\\b|\\bis an? (?:mba|phd|master'?s) worth\\b`)],
  ["topic:linkedin", R(`\\blinkedin\\b`)],
  ["topic:events", R(`\\bcareer fairs?\\b|\\bjob fairs?\\b|\\bhandshake\\b|\\bhackathons?\\b|\\bconferences?\\b|\\bnetworking events?\\b|\\bmeetups?\\b`)],
  ["topic:deadline", R(`\\bdeadline\\b|\\bexploding offer\\b|\\bhave until\\b|\\bneed to (?:decide|respond) by\\b|\\bmore time\\b|\\bto (?:answer|decide|respond)\\b|\\bextension\\b`)],
  ["topic:multi_offer", R(`\\b(?:two|2|three|3|multiple|several|competing) offers\\b|\\b(?:a |another |second |other )?competing offer\\b|\\banother offer\\b|\\bbetter (?:offer|one)\\b|\\bback out\\b|\\brenege\\b|\\baccepted an offer\\b`)],
  ["topic:weekly_plan", R(`\\bweekly plan\\b|\\bhours (?:a|per) week\\b|\\bplan for my job search\\b|\\bfit (?:a |the |my )?job search\\b|\\bno time\\b|\\bschedule for my (?:job )?search\\b`)],
  ["topic:evaluate", R(`\\bhow do i know if\\b|\\bstable enough\\b|\\bworth joining\\b|\\bhow (?:stable|risky)\\b|\\bhow (?:do|should|can) i evaluate\\b|\\bdon'?t understand (?:it|the|this)\\b`)],
  ["topic:search_plan", R(`\\bhow (?:do|should|can) i (?:find|get|land|start|break)\\b|\\bjob search\\b|\\bwhere (?:do|should) i (?:look|start|apply)\\b|\\bwhat should i do\\b|\\bhow do i get (?:those|them|one|it|hired)\\b`)],
];

export interface TextSignals { level: Level | null; tags: Set<string> }

// A grade point average below 3.0, said by the person ("my GPA is 2.7", "2.6 gpa"), or called low outright.
export function lowGpa(text: string): boolean {
  const t = String(text ?? "");
  const m = /\bgpa\b[^.\d]{0,20}(\d(?:\.\d+)?)/i.exec(t) ?? /(\d\.\d+)\s*(?:\/\s*4(?:\.0+)?\s*)?gpa/i.exec(t);
  if (m) { const v = Number(m[1]); if (v > 0 && v < 3.3) return true; }
  return /\blow gpa\b|\bbad (?:grades|gpa)\b|\bgpa (?:is )?(?:bad|low|terrible|awful)\b/i.test(t);
}
// Five or more years in a field, said outright, or a title that says experience.
export function midCareer(text: string): boolean {
  const NUM: Record<string, number> = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
  const m = /\b(\d{1,2}|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\+? years?,? (?:of )?(?:experience|in|as|working|at|into)\b/i.exec(text) ?? /,\s*(\d{1,2}|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty) years?\b/i.exec(text);
  if (m && (NUM[m[1].toLowerCase()] ?? Number(m[1])) >= 5) return true;
  return /\b(?:i'?m|i am|as) an? (?:senior|staff|lead|principal) (?:\w+ )?(?:engineer|analyst|manager|designer|developer|accountant|nurse|teacher)\b|\b(?:director|vp|head) of\b/i.test(text);
}

export function signalsOf(text: string): TextSignals {
  const t = String(text ?? "").replace(/[’]/g, "'").slice(0, 4000);
  const tags = new Set<string>();
  let level: Level | null = null;
  for (const [l, rx] of LEVEL_RX) if (rx.test(t)) { level = l; break; }
  if (!level && midCareer(t)) level = "mid_career";
  if (level) tags.add(`stage:${level}`);
  for (const [tag, rx] of OVERLAY) if (rx.test(t)) tags.add(tag);
  for (const [tag, rx] of TOPIC) if (rx.test(t)) tags.add(tag);
  if (lowGpa(t) || /\b(?:round|inflate|bump|fudge|lie about|hide|leave off|leave out)\b[^.]{0,30}\bgpa\b|\bgpa\b[^.]{0,30}\b(?:round|inflate|fudge|lie)/i.test(t)) tags.add("ctx:low_gpa");
  // Said outright, a sponsorship need is not a student question: both tags stay, retrieval reads them together.
  if (tags.has("topic:multi_offer")) tags.add("topic:deadline");
  return { level, tags };
}

export const isTopic = (tag: string) => tag.startsWith("topic:");

// Every tag signalsOf can produce (the lint test checks a playbook's `when` and `boost` against this list).
export const ALL_TAGS: ReadonlySet<string> = new Set([
  ...LEVELS.map((l) => `stage:${l}`),
  ...OVERLAY.map(([t]) => t),
  ...TOPIC.map(([t]) => t),
  "ctx:low_gpa",
]);

// A fact the person confirmed about school reads shorter than a sentence ("Junior, finance"): a bare year word counts there.
export function levelOfFact(text: string): Level | null {
  const l = signalsOf(text).level;
  if (l) return l;
  const m = /\b(freshman|sophomore|junior|senior)\b(?! (?:analyst|developer|engineer|designer|role|position|associate|level|dev|accountant|manager|marketer|writer))/i.exec(String(text ?? ""));
  return m ? (m[1].toLowerCase() as Level) : null;
}

// "I want to become / get into / switch to X" said by someone who already works in something else: a career change.
export const wantsSwitch = (text: string) => /\bwant(?:s|ed)? to (?:become|be|get into|move into|break into|switch to|pivot to|transition (?:in)?to)\b|\b(?:get|move|break) into\b|\bthinking about (?:a |the )?(?:move|switch|change)\b/i.test(text);
export const saysCurrentWork = (text: string) => /\bi (?:teach|manage|run|do|handle|lead|sell|write|cook|drive|design|code|work)\b|\bi'?m an? \w+|\bi'?ve (?:only )?been\b|\bi was an? \w+|\b(?:for|about) (?:\d+|\w+) years\b/i.test(text);
export const switchIntent = (text: string) => wantsSwitch(text) && saysCurrentWork(text);
