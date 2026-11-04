// Step 3 (the file): the research brief, a markdown document built by code from (a) retrieved, guard-accepted facts, each cited
// to a source, (b) labelled general knowledge from fields.ts, and (c) the person's own facts. Nothing in it is a model's
// recollection. Section order is fixed; every section says plainly when it has nothing sourced to say.
import type { Fact, Grounded } from "./ground.ts";
import type { Kind } from "./fields.ts";
import type { StageGroup, Understanding } from "./understand.ts";
import { unsourcedIn } from "./guard.ts";

type Slot = "foundation" | "experience" | "credential" | "target";
const LADDER: Record<StageGroup, [string, Slot[]][]> = {
  early_student: [["This semester", ["foundation"]], ["This summer", ["experience"]], ["Next academic year", ["credential", "target"]]],
  late_student: [["This term", ["foundation", "credential"]], ["Before the next recruiting season", ["experience"]], ["Then", ["target"]]],
  new_grad: [["First month", ["foundation"]], ["The next few months", ["experience", "target"]], ["Alongside the search", ["credential"]]],
  grad_student: [["This term", ["foundation", "credential"]], ["Before the recruiting window opens", ["experience"]], ["Then", ["target"]]],
  switcher: [["First month", ["foundation"]], ["The next few months", ["credential", "experience"]], ["Then", ["target"]]],
  displaced: [["This week", ["foundation"]], ["The next few weeks", ["experience", "target"]], ["Alongside the search", ["credential"]]],
  experienced: [["First month", ["foundation"]], ["The next few months", ["credential", "experience"]], ["Then", ["target"]]],
  unknown: [["First month", ["foundation"]], ["The next few months", ["experience", "target"]], ["Alongside the search", ["credential"]]],
};
const STAGE_NOTE: Record<StageGroup, string> = {
  early_student: "You have the longest runway of anyone in this process, so the work now is building evidence and relationships rather than landing the biggest name.",
  late_student: "Your window is the next recruiting season, so sequence matters more than breadth.",
  new_grad: "You are past the easiest on-ramp, so the work is applying widely and quickly while you keep building proof.",
  grad_student: "Your degree is the credential; the work is turning it into one specific role and hitting the recruiting window.",
  switcher: "You are not starting over; the task is translating what you have done into this field's terms and producing one credible proof point.",
  displaced: "Run the search like a job with a weekly schedule, and protect the basics first.",
  experienced: "Your record is the asset; the task is aiming it at the right door and making it easy to read.",
  unknown: "",
};
const gk = (s: string) => `${s} (general knowledge)`;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export interface Brief { markdown: string; sources: { n: number; url: string; label: string }[]; used: Fact[]; dropped: string[] }
export function composeBrief(o: { u: Understanding; g: Grounded; message: string; today: string }): Brief {
  const { u, g } = o, f = u.field!;
  const facts = g.facts, byKind = (...k: Kind[]) => facts.filter((x) => k.includes(x.kind));
  const urls: string[] = [];
  const cite = (x: Fact) => { let i = urls.indexOf(x.url); if (i < 0) i = urls.push(x.url) - 1; return `[S${i + 1}, ${x.label}]`; };
  const L: string[] = [];
  const sec = (h: string) => L.push("", `## ${h}`, "");

  L.push(`# ${cap(f.label)}: your plan`, "", `Written for ${u.stageLabel} aiming at ${f.label}${u.geoKey === "us" ? " in the US" : ` in ${u.geo}`}, as of ${o.today}.`);
  if (u.confirmed.length) L.push("", `What I am working from (confirmed): ${u.confirmed.join("; ")}.`);
  if (u.said.length) L.push(`What you mentioned (not yet confirmed, so I only advise from it): ${u.said.join("; ")}.`);
  for (const a of u.assumptions) L.push("", `Assumption: ${a}`);

  sec("Honest read");
  if (STAGE_NOTE[u.stage]) L.push(gk(STAGE_NOTE[u.stage]), "");
  L.push(`**Realistic now.** ${gk(f.now)}`, "", `**Realistic later.** ${gk(f.later)}`);
  for (const v of u.overlays) L.push("", gk(v.read));
  if (u.qtype === "pay") L.push("", "You asked about pay: the only figures in this brief are the sourced ones under \"What the data says\"; pay varies by region and employer.");

  sec("Your next three actions (this week)");
  L.push(`- ${gk(f.slots.foundation)}`, `- ${gk(`Message one person from the networking list below and ask for a fifteen-minute call. Start with: ${f.who[0][0].toLowerCase()}${f.who[0].slice(1)}.`)}`, `- ${gk(f.credentials[0])}`);

  sec("The usual route and where you are on it");
  L.push(`You are here: ${u.year ? `a ${u.year}` : u.stageLabel}.`, "", ...f.cycle.map((x) => `- ${gk(x)}`));
  const when = byKind("timeline");
  if (when.length) L.push("", "Dates and timing from sources I retrieved:", ...when.map((x) => `- ${x.text} ${cite(x)}`));
  else L.push("", "No source I retrieved gave current dates for this route, so none are stated here; confirm each employer's dates on its own careers page.");

  sec("Honest odds");
  L.push(gk(f.odds));
  const elig = byKind("eligibility");
  if (elig.length) L.push("", "Requirements and expectations from sources I retrieved:", ...elig.map((x) => `- ${x.text} ${cite(x)}`));
  else L.push("", "I found no sourced acceptance rate, grade cutoff or school list, so I am giving none; ask the employer or your career center for the real figures.");

  sec("The path, in stages");
  const stageLines = new Map<string, string[]>();
  const rungs = LADDER[u.stage];
  rungs.forEach(([when, slots], i) => {
    const lines = slots.map((s) => gk(f.slots[s]));
    if (i === 0) for (const v of u.overlays) if (v.stage) lines.push(gk(v.stage));
    stageLines.set(when, lines);
  });
  for (const [when, lines] of stageLines) L.push(`**${when}**`, ...lines.map((x) => `- ${x}`), "");
  L.pop();

  sec("Where to aim");
  L.push("Categories (general knowledge):", ...f.targets.map((t) => `- ${t}`), "");
  const named = byKind("employer", "program");
  if (named.length) L.push("Named employers and programs, each from a source I retrieved:", ...named.map((x) => `- ${x.text} ${cite(x)}`));
  else L.push("I did not retrieve any named employers or programs for your situation, so I am listing categories only and not guessing names. Your school's career office or the field's industry body will have current lists.");

  sec("Networking plan");
  L.push(gk("The goal of every conversation is advice, not a job: you are asking for one fifteen-minute informational chat, and you never ask for a job or a referral in the first message."), "", "**Who to talk to** (categories; I do not name or invent people):", ...f.who.map((x) => `- ${x}`));
  for (const v of u.overlays) if (v.network) L.push(`- ${v.network}`);
  L.push("", "**The first message** (fill the brackets with things that are true and that you checked):", "",
    "> Hi [Name], I'm [your situation, one line] and I'm exploring [role or field]. I saw that [one specific, true thing about their path]. Would you be open to a fifteen-minute call in the next couple of weeks? I'd like to hear how you got started. I'm asking for advice, not a job.", "",
    "**What to ask once you are on the call:**", ...f.asks.map((x) => `- ${x}`), "",
    "**Afterward:** send a thank-you within a day that names one thing you will do with their advice; tell them what happened a few weeks later; ask for one more name only if the conversation went well.");

  sec("Skills and credentials");
  L.push(gk("How to get each one:"), ...f.credentials.map((x) => `- ${x}`));
  const cred = byKind("credential");
  if (cred.length) L.push("", "From sources I retrieved:", ...cred.map((x) => `- ${x.text} ${cite(x)}`));

  sec("What the data says");
  const data = byKind("pay", "outlook");
  if (data.length) L.push(...data.map((x) => `- ${x.text} ${cite(x)}`));
  else L.push("No pay or outlook figures came back from a source I could trace, so I am quoting none.");

  sec("What I couldn't verify");
  const miss: string[] = [...f.verify, ...u.overlays.flatMap((v) => v.verify ? [v.verify] : [])];
  for (const [label, kinds] of [["current pay figures", ["pay"]], ["a hiring outlook", ["outlook"]], ["grade, school or eligibility expectations", ["eligibility"]], ["recruiting or application timing", ["timeline"]], ["named employers or programs", ["employer", "program"]]] as [string, Kind[]][]) {
    if (!byKind(...kinds).length) miss.push(`No retrieved source for ${label}`);
  }
  miss.push(...g.notes.map(cap));
  if (g.rejected.length) { const n = g.rejected.length; miss.push(`${n === 1 ? "One retrieved claim was" : n < 10 ? "Several retrieved claims were" : "Many retrieved claims were"} dropped because I could not trace ${n === 1 ? "it" : "them"} to a quote on the source page`); }
  L.push(...miss.map((x) => `- ${x}`));

  L.push("", "## Sources", "");
  if (urls.length) urls.forEach((url, i) => L.push(`${i + 1}. S${i + 1}: ${url} (${facts.find((x) => x.url === url)!.label}, retrieved ${o.today})`));
  else L.push("No sources were retrieved. Everything above marked \"general knowledge\" is standard practice, not data.");

  // The final guard: any line with a number or name no source, no fact of the person's and no general term accounts for is dropped.
  const support = { facts, person: [...u.confirmed, ...u.said, o.today, f.label], message: o.message };
  const dropped: string[] = [];
  const kept = L.filter((line, i) => {
    if (!line.trim() || /^#|^\d+\. S\d/.test(line) || line.startsWith(">")) return true;
    const bad = unsourcedIn(line, support);
    if (bad.length) { dropped.push(`${line.slice(0, 80)} [${bad.join(", ")}]`); return false; }
    return true;
  });
  const markdown = kept.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  return { markdown, sources: urls.map((url, i) => ({ n: i + 1, url, label: facts.find((x) => x.url === url)!.label })), used: facts, dropped };
}
