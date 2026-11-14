// The scripted brain of the mirror process test (moved verbatim from tests/architect/mirror-wa-batch1-process.test.ts, architect
// amendment (D-066), so tests/architect/behavior-guide-suite.test.ts runs the same turns without re-running that file's tests).
// Nothing in it changed: the same steps, texts, stubbed web search and research draft.
import type { Call, Step } from "./mirror_process.ts";
import { PAYPAL } from "./mirror_process.ts";
import { C16_STEPS, C19_STEPS, C6_STEPS } from "./d062_fixtures.ts";

// What the brain does on each EXISTS turn (the process's tool calls) and its final words; code decides what each call returns.
export const C2_BODY = "Hi [Name], I'm Sam, a Computer Science and Finance student at Lakeshore looking for a summer 2027 SWE internship at Google: [job link]. I'm building Waypoint, a career agent, and previously built 70+ React websites for clients through Pixelforge. Would you be open to taking a look at my resume and considering a referral if you think I'd be a fit? Best, Sam";
export const C14_BODY = "Hey [Name], I'm a Lakeshore CS student interested in this Google SWE internship: [job link]. Would you be open to referring me if you think I'd be a fit? Happy to send my resume.";
export const C13_BODY = "Hey, quick question: is there any flexibility in the listed comp range for this role, or is it fixed? Thanks!";
export const C5_Q = "Given a list of integers, write a Python function that returns the first number that appears only once, or None if there isn't one. Talk me through your approach before writing code, including its time and space complexity.";
export const C21_Q = "Tell me about a time you failed: what were you responsible for, what went wrong, and what did you do afterward?";
// D-060 web research at $0: a stubbed web search on the Anthropic wire (the shape the live proof recorded, evals/research-live/)
// quoting these passages; the market draft (market.ts RULES) quotes them back word for word. The pages themselves are refused
// like every other host, so each passage stands for its page (via "search_passage"), as D-060 allows.
export const C4_GUIDE = "https://student-to-software-engineer.org/docs/find-your-first-internship/resumes/";
// Architect amendment (owner decision 2026-11-13: research support check switched on; architect ruling 2026-11-14, by shape): advice
// skips the page judge only when every name in it is of the person's own record. "SWE" is not (a goal said in chat, never saved as a
// fact), so it is taken out; "Leave the outdated 3.9 GPA off." stands as written (it removes a draft fact of theirs). Closed world
// (review of 1f3f5f18a): only the leading verb is a verb, so the skills line is "with" its skills, not "led by" them.
export const C4_ANSWER = "For the top of your resume: your name and contact links, then \"Lakeshore University | BS Computer Science and Finance | Expected June 2029\", then a compact skills line with Python, TypeScript/JavaScript, React and SQL. Leave the outdated 3.9 GPA off.";
export const C9_Q = "what's citadel like for new grad swe, culture pay interview process, give me real sources";
export const CITADEL_QUERIES = ["Citadel new grad software engineer pay", "Citadel engineering interview process", "Citadel culture hours"];
export const WEB: Record<string, { title: string; text: string }> = {
  "https://www.citadel.com/careers/details/software-engineer-university-graduate-us": { title: "Software Engineer - University Graduate (US) - Citadel", text: "The base salary range for this role is $235,000 to $300,000, plus a discretionary bonus." },
  "https://www.citadel.com/careers/career-perspectives/our-engineering-interview-process": { title: "Our Engineering Interview Process - Citadel", text: "At Citadel, the overall process takes roughly eight weeks from start to finish." },
  "https://www.reddit.com/r/quant/comments/10d7lv1/why_do_people_say_citadel_has_bad_wlb": { title: "Why do people say Citadel has bad WLB? : quant", text: "Anonymous posters describe demanding hours and performance pressure at Citadel." },
  "https://www.citadelsecurities.com/careers/engineering": { title: "Engineering at Citadel Securities", text: "Citadel Securities is a market maker, a separate firm from Citadel." },
  "https://www.levels.fyi/internships/Relativity/Software-Engineer-Intern": { title: "Relativity Software Engineer Intern pay", text: "Relativity software engineer interns in Chicago report $32 per hour." },
  "https://www.levels.fyi/internships/CME-Group/Software-Engineer-Intern": { title: "CME Group Software Engineer Intern pay", text: "CME Group software engineer interns in Chicago report $34 per hour." },
  // Architect amendment (D-063): C4's guide page (the one Instinct cited), one quoted passage.
  [C4_GUIDE]: { title: "Resumes | Student to Software Engineer", text: "Start with your name and contact links, then education with your school, degree and expected graduation date, followed by a short technical skills section." },
};
export const WEB_BY_TURN: Record<string, string[]> = { C9: Object.keys(WEB).slice(0, 4), C23: Object.keys(WEB).slice(0, 4), C22: Object.keys(WEB).slice(4, 6), C4: [C4_GUIDE] };
export const web = (body: any, turn: string) => {
  const urls = WEB_BY_TURN[turn] ?? [];
  return { id: "msg_search", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [
    { type: "server_tool_use", id: "srvtoolu_mp", name: "web_search", input: { query: "q" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_mp", content: urls.map((u) => ({ type: "web_search_result", url: u, title: WEB[u].title, encrypted_content: "x", page_age: "10 days ago" })) },
    ...urls.map((u) => ({ type: "text", text: WEB[u].text, citations: [{ type: "web_search_result_location", url: u, title: WEB[u].title, cited_text: WEB[u].text, encrypted_index: "x" }] })),
  ], usage: { input_tokens: 9000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } } };
};
export const draft = (system: string, user: string) => /^You answer a market research question from the PAGES/.test(system)
  ? JSON.stringify({ title: "Research", summary: Object.entries(WEB).filter(([u]) => user.includes(u)).map(([url, p]) => ({ text: p.text.replace(/\.$/, ""), quote: p.text, url })) })
  : null;
// The source number research_market gave a page (by a piece of its address), for the brain's citation.
export const cite = (calls: Call[]) => { const r = JSON.parse(calls.find((c) => c.name === "research_market")?.result || "{}"); return (part: string) => (r.sources ?? []).find((x: any) => String(x.url).includes(part))?.n; };
export const SCRIPT: Record<string, Step[]> = {
  // Architect amendment (D-063): C4, C10, C20 (moved from pending/mirror-process-blocked.test.ts).
  C4: [{ tool: "research_career_question", input: { question: "what should i put at the very top of my resume for swe roles, be specific", kind: "advice", query: "student software engineer resume header what to put at the top" } }, { text: C4_ANSWER }],
  C10: [{ tool: "tailor_resume", input: { job_id: PAYPAL.id } }, { text: "Your tailored PDF is attached, with the skills reordered for PayPal; the email at the top is a [your email] placeholder. Treat it as a review draft. Nothing was submitted." }],
  C20: [{ tool: "tailor_resume", input: { job_id: PAYPAL.id, edits: [{ role: "Pixelforge", lines: 1 }, { role: "Waypoint", lines: 3 }] } }, { text: "Updated: Pixelforge is one line, and Waypoint leads with what your record holds. Still a review draft; nothing was submitted." }],
  C2: [{ tool: "draft_followup", input: { kind: "note", recipient: "", body: C2_BODY } }, { text: "Here it is." }],
  C5: [{ text: C5_Q }],
  C5f1: [{ text: "That's the right approach: count first, then scan the original list. Can you write the function now, including what it returns for an empty list?" }],
  C5f2: [{ text: "An empty list or one with no unique number raises StopIteration instead of returning None; use next(..., None). Follow-up: what if the input is a generator you can only read once?" }],
  C7: [{ tool: "add_profile_fact", input: { kind: "offer", text: "Offer: $120,000 in Chicago" } }, { text: "I'd compare what you keep after taxes and rent, not the headline salaries." }],
  C8: [{ tool: "get_profile", input: {} }, { text: "From your resume and what you've told me: Pixelforge, Rallyup, Waypoint, Harbor Global, Crestline. The gaps: Harbor's dates and Crestline's exact name." }],
  C12: [{ text: "I couldn't responsibly promise 50 completed applications overnight. I'd measure a small approved batch first; nothing is being applied to now." }],
  C13: [{ tool: "draft_followup", input: { kind: "note", recipient: "", tone: "casual", body: C13_BODY } }, { text: "Here it is." }],
  C14: [{ tool: "draft_followup", input: { kind: "note", recipient: "", tone: "way shorter, less formal", body: C14_BODY } }, { text: "Here it is." }],
  C15: [{ tool: "add_profile_fact", input: { kind: "education", text: "new grad, zero internships, mid GPA" } }, { text: "In that situation, I'd build the resume around one or two projects you can demo." }],
  C17: [{ tool: "get_profile", input: {} }, { text: "I'm studying computer science and finance at Lakeshore; I started Pixelforge and built over 70 React websites, and now I'm building Waypoint." }],
  C11: [{ tool: "inspect_apply_flow", input: { job_id: PAYPAL.id } }, { text: `To submit it I'd need your approval of the final resume, the email and phone to put on it, and your answers to the form's own questions. I couldn't read PayPal's form just now, so I can't list those questions yet. I only read the public pages: no account, saved application or submission was created.\n${PAYPAL.url}` }],
  C18: [{ tool: "check_posting_open", input: { url: PAYPAL.url } }, { text: `I couldn't check PayPal's posting just now, so I can't call it open. Nothing was applied for.\n${PAYPAL.url}` }],
  C9: [{ tool: "research_market", input: { question: C9_Q, format: "inline", companies: ["Citadel"], queries: CITADEL_QUERIES } }, { text: (calls) => {
    const n = cite(calls);
    return [`Pay: Citadel's posting lists a base salary range of $235,000 to $300,000, plus a discretionary bonus [${n("software-engineer-university-graduate")}].`,
      `Interviews: the overall process takes roughly eight weeks [${n("our-engineering-interview-process")}].`,
      `Culture: anonymous posters describe demanding hours and performance pressure at Citadel, anecdotes rather than proof [${n("reddit.com")}].`,
      `Citadel and Citadel Securities are different employers, so keep their figures apart [${n("citadelsecurities.com")}].`].join("\n\n");
  } }],
  C22: [{ tool: "get_posting", input: { job_id: PAYPAL.id } }, { tool: "research_market", input: { question: "what's the going rate for swe interns in chicago, hourly", format: "inline", queries: ["software engineer intern hourly pay Chicago"] } }, { text: (calls) => {
    const n = cite(calls);
    return `Self-reported pay, which can lag: Relativity software engineer interns in Chicago report $32 per hour [${n("Relativity")}], and CME Group software engineer interns in Chicago report $34 per hour [${n("CME-Group")}].`;
  } }],
  C21: [{ text: `${C21_Q} Give me the answer you'd actually say, and I'll be blunt.` }],
  C21f: [{ text: "Right now that's a plot summary, not an answer: what did YOU get wrong, and what did redoing it cost?" }],
  C23: [{ tool: "research_market", input: { question: C9_Q, format: "inline", companies: ["Citadel"], queries: CITADEL_QUERIES } }, { text: (calls) => `At Citadel, the overall process takes roughly eight weeks [${cite(calls)("our-engineering-interview-process")}].` }],
  // Architect amendment (D-062): the capability turns (tests/architect/helpers/d062_fixtures.ts).
  C6: C6_STEPS, C16: C16_STEPS, C19: C19_STEPS,
};
