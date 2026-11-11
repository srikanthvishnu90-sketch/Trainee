// D-062 (owner, 2026-11-11: "be able to answer emails, find alumni, do all of it. not gmail read, but gmail read and send"): the
// $0 fixtures of the capability turns (MIRROR-PROCESS C6, C16, C19). The scripted brain calls the tool the process names and then
// writes its reply FROM WHAT THE TOOL RETURNED (as the C9 and C22 scripts do), so a tool that returns nothing usable fails the
// turn's checks. The web search is stubbed on the Anthropic wire in the shape the live proof recorded (evals/research-live/):
// result pages, the passages quoted from them word for word, and the search model's JSON proposal of leads. Every person and page
// here is fictional.
import type { Call, Step } from "./mirror_process.ts";

const parse = (calls: Call[], name: string) => { try { return JSON.parse(calls.find((c) => c.name === name)?.result || "{}"); } catch { return {}; } };

// The people search's stub answer: four results, one on LinkedIn (dropped unopened), one whose page never names the employer
// (dropped), three that stand.
export const PEOPLE_PAGES = [
  { url: "https://news.lakeshore-university.example/alumni/priya-raman", title: "Alumni spotlight: Priya Raman", text: "Priya Raman, a 2021 Lakeshore University computer science graduate, is a software engineer at Google." },
  { url: "https://marcuslee.example.dev/about", title: "Marcus Lee | About", text: "Marcus Lee studied at Lakeshore University and works as a quantitative developer at Citadel." },
  { url: "https://events.lakeshore-university.example/cs-alumni-panel", title: "CS alumni panel", text: "Dana Ortiz, software engineer at Jane Street, spoke at the Lakeshore CS alumni panel." },
  { url: "https://www.linkedin.com/in/sam-kim-example", title: "Sam Kim - Google | LinkedIn", text: "Sam Kim, Lakeshore University, Google." },
  { url: "https://blog.example.org/jordan", title: "Jordan Fields", text: "Jordan Fields graduated from Lakeshore University in 2019." },
];
export const PEOPLE_PROPOSED = [
  { name: "Priya Raman", role: "software engineer", employer: "Google", school: "Lakeshore University", url: PEOPLE_PAGES[0].url },
  { name: "Marcus Lee", role: "quantitative developer", employer: "Citadel", school: "Lakeshore University", url: PEOPLE_PAGES[1].url },
  { name: "Dana Ortiz", role: "software engineer", employer: "Jane Street", school: "Lakeshore", url: PEOPLE_PAGES[2].url },
  { name: "Sam Kim", role: "", employer: "Google", school: "Lakeshore University", url: PEOPLE_PAGES[3].url },
  { name: "Jordan Fields", role: "trader", employer: "Citadel", school: "Lakeshore University", url: PEOPLE_PAGES[4].url },
];
export const peopleSearchAnswer = (body: any) => ({ id: "msg_people", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [
  { type: "server_tool_use", id: "srvtoolu_people", name: "web_search", input: { query: "Lakeshore alumni" } },
  { type: "web_search_tool_result", tool_use_id: "srvtoolu_people", content: PEOPLE_PAGES.map((p) => ({ type: "web_search_result", url: p.url, title: p.title, encrypted_content: "x", page_age: "3 months ago" })) },
  ...PEOPLE_PAGES.map((p) => ({ type: "text", text: `${p.text} `, citations: [{ type: "web_search_result_location", url: p.url, title: p.title, cited_text: p.text, encrypted_index: "x" }] })),
  { type: "text", text: JSON.stringify(PEOPLE_PROPOSED) },
], usage: { input_tokens: 9000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } } });
// The people search is told who it is (career_alumni_search.ts PEOPLE_SYSTEM); any other search gets the caller's own stub.
export const isPeopleSearch = (body: any) => /You find public information about people/.test(String(body?.system ?? ""));

// C6: what the record holds, said from the record: Gmail (or how to connect it), applications, research kept apart, the offer.
export const C6_STEPS: Step[] = [{ tool: "read_application_mail", input: {} }, { text: (calls) => {
  const r = parse(calls, "read_application_mail");
  const research = (r.researched ?? []).map((x: any) => `${x.company}${x.role ? ` (${x.role})` : ""}`).join(", ");
  return [
    r.mail?.gmail === "connected" ? `From your Gmail confirmations, ${r.applied?.length ?? 0} applications went out.` : `I couldn't check your email confirmations: no Gmail is connected, so this is only what Trainee has on record. You can connect it yourself:\n${r.connect_url}`,
    (r.applied ?? []).length ? (r.applied as any[]).map((a) => `${a.company}: ${a.status}`).join("\n") : "Nothing on record has been submitted.",
    research ? `${research} was research only from tonight, not an application.` : "",
    "Want me to set up a tracker for these?",
  ].filter(Boolean).join("\n\n");
} }];
// C16: the tracker made (or why not), its coverage, and corrections said out loud.
export const C16_STEPS: Step[] = [{ tool: "export_tracker", input: {} }, { text: (calls) => {
  const r = parse(calls, "export_tracker");
  if (r.status !== "ok") return `I couldn't make the tracker page just now (${r.why ?? "no reason given"}). Nothing was submitted or sent.`;
  const fix = (r.changes ?? []).map((c: any) => `Correction: ${c.what} was ${c.was}, it's ${c.now}.`).join(" ");
  return [`Your tracker has ${r.counts.applied} applications, ${r.counts.researched} researched roles and ${r.counts.drafts} drafts.`, fix, `It covers: ${(r.coverage ?? []).join("; ")}.`].filter(Boolean).join("\n\n");
} }];
// C19: one people search; the leads as returned, one to start with; the boundary is left to code (enforcePeopleReply).
export const C19_INPUT = { school: "Lakeshore University", employers: ["Google", "Citadel", "Jane Street"], count: 3 };
export const C19_STEPS: Step[] = [{ tool: "find_people", input: C19_INPUT }, { text: (calls) => {
  const r = parse(calls, "find_people");
  if (r.status !== "ok") return `I didn't find anyone I can stand behind (${r.status}).`;
  const lines = (r.leads as any[]).map((l, i) => `${i + 1}. ${l.name}, ${l.role ?? "role not shown"} at ${l.employer}; the page ${l.school_match === "shown" ? "shows" : "does not show"} Lakeshore\n${l.url}`);
  const p = r.priority ? `I'd start with ${r.leads[r.priority.index].name}: ${r.priority.why.join("; ")}.` : "";
  return [`These come from public search excerpts and are not verified; current employment needs confirming.`, ...lines, p].filter(Boolean).join("\n");
} }];
