// Task planner, the plan and its checks (pure; no I/O). Ported from PR #252 (TASK-INTELLIGENCE-SPEC-2026-10-27): the
// model picks capabilities and fills inputs; code checks every step and every step runs through a path that already
// exists and already enforces the owner's rules. What was ported: the strict plan_task tool schema, "registered
// capability only", the owner rule that LinkedIn, Indeed and Handshake are never automated (forbiddenTargets), the
// provenance rule that an address or link a step acts on must come from the person's own words (targetsOf/untrusted),
// and the per-person reversible switch. What was NOT ported: #252's own registry of new external effects, its plan,
// effect and card tables (migration 20261027260000) and its card grammar. Here every capability is routed to a code path
// on trunk (the router, the apply turn, the networking turn, the tracker tool, the standing-instruction tool) or to the
// reminder store, so approvals (the apply card, the outreach "send 1"), the fact-lock (D-007) and the kill switches are
// the ones those paths already have. Nothing here sends anything.
// deno-lint-ignore-file no-explicit-any

export const PLAN_INTENT = "career_plan";

// A capability: what the planner model may ask for. `route` is the existing path it runs through (career_planner.ts).
export interface Capability { name: string; route: "router" | "apply" | "networking" | "tool" | "reminder"; summary: string; args?: Record<string, string> }
export const CAPABILITIES: readonly Capability[] = [
  { name: "jobs.search", route: "router", summary: "Find open postings (role, place, level). Its text is the person's search words, e.g. \"find 5 frontend internships in Chicago\"." },
  { name: "apply.queue", route: "apply", summary: "Put postings in the person's own apply queue. Nothing is sent: each goes only after they approve its card. For postings the search step found, give picks (1-based positions in that list, best first); for one named role, give the text \"apply to the <role> role at <company>\".", args: { picks: "array of 1-based positions in the search step's list" } },
  { name: "resume.tailor", route: "router", summary: "Tailor the resume from confirmed facts for postings. For postings the search step found, give picks; for one named role, the text \"tailor my resume for the <role> role at <company>\".", args: { picks: "array of 1-based positions in the search step's list" } },
  { name: "outreach.draft", route: "networking", summary: "Draft an email to someone in the person's own contacts (\"email Maya at Stripe about the data analyst role\", \"email a recruiter at Stripe\"). Drafted only; nothing is sent until they approve the exact message." },
  { name: "tracker.update", route: "tool", summary: "Record an application or interview on the person's tracker.", args: { company: "employer as they said it", role: "role, if said", stage: "Saved, Submitted, Recruiter screen, OA/assessment, Interview rounds, Final, Offer, Rejected, Withdrawn or Accepted", when: "the day or time of the next step in their own words, if said" } },
  { name: "interview.prep", route: "router", summary: "A prep brief for an interview: the text \"prep me for my <company> interview\"." },
  { name: "alerts.watch", route: "router", summary: "Watch for new postings and alert the person: the text \"watch <role> roles in <place>\"." },
  { name: "reminder.set", route: "reminder", summary: "Remind the person of something on a day they named (\"remind me Friday to follow up\", \"follow up in a week\").", args: { what: "what to remind them of, in their words", when: "the day in their own words, e.g. 'Friday', 'in a week', 'Tuesday'" } },
  { name: "instruction.remember", route: "tool", summary: "Keep a standing rule they stated (\"no staffing agencies\", \"I need visa sponsorship\").", args: { instruction: "the rule, short", quote: "their exact words" } },
];
export const capability = (name: string) => CAPABILITIES.find((c) => c.name === name) ?? null;

export const PLAN_TOOL = {
  name: "plan_task",
  description: "Record the person's message as steps over Trainee's capabilities.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["task", "not_a_task"] },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            capability: { type: "string", enum: CAPABILITIES.map((c) => c.name) },
            text: { type: "string", description: "This part of the person's message, in their own words" },
            args: { type: "object" },
          },
          required: ["capability", "text"],
        },
      },
    },
    required: ["kind"],
  },
};

export function planSystem(): string {
  return [
    "You split a person's message to Trainee, a career agent, into steps over Trainee's capabilities, and reply only through the plan_task tool.",
    "kind: task when the message asks for actions; not_a_task for conversation, advice or a question.",
    "One step per action, in the order the person wants them done. A compound ask is several steps; never leave a part out.",
    "Each step's text is that part of the person's message in their own words. Never put an email address, name, link or day in a step unless the person wrote it.",
    `At most ${MAX_STEPS} steps. Every application goes in ONE apply.queue step and all tailoring in ONE resume.tailor step (all picks together); at most ${MAX_REMINDERS} reminder.set steps; at most ${MAX_PICKS} picks per step. Code refuses the rest and tells the person.`,
    "Capabilities:",
    ...CAPABILITIES.map((c) => `- ${c.name}: ${c.summary}${c.args ? ` args: ${JSON.stringify(c.args)}` : ""}`),
  ].join("\n");
}

// ------------------------------------------------------------------------------------------------ when to plan
// The actions a message can ask for, by their verbs. A message with two or more distinct actions is a compound ask and
// goes to the planner; a single ask stays on today's chain unchanged (no model call is spent on it).
const ACTIONS: [string, RegExp][] = [
  ["search", /\b(?:find|search|look (?:for|up)|show me|get me|pull up)\b/i],
  ["apply", /\bappl(?:y|ying)\b|\bsubmit\b|\bdraft (?:the |my )?applications?\b/i],
  ["tailor", /\btailor(?:ed|ing)?\b|\bcustomi[sz]e my resume\b/i],
  ["email", /\b(?:email|e-mail|message|reach out to|write to|draft (?:an? )?(?:email|note|message))\b/i],
  ["remind", /\bremind\b|\bfollow[- ]?up\b|\bcheck back\b/i],
  ["track", /\btracker\b|\btrack(?:ing)? (?:it|this|that|them)\b|\badd (?:it|this|that) to my\b/i],
  ["prep", /\bprep(?:are)?\b|\bmock\b|\bpractice\b/i],
  ["watch", /\bwatch\b|\balert(?:s)? me\b|\bset (?:up )?(?:an? )?(?:job )?alerts?\b/i],
  ["remember", /\bremember (?:that |this )?i\b|\bremember (?:that|this)\b|\bnever want\b|\bnever (?:apply|send|show)\b/i],
];
export function actionsIn(message: string): string[] {
  const m = String(message ?? "");
  return ACTIONS.filter(([, re]) => re.test(m)).map(([k]) => k);
}
export function compoundAsk(message: string): boolean {
  const m = String(message ?? "");
  if (m.length > 2000 || /\?\s*$/.test(m.trim()) && actionsIn(m).length < 2) return false;
  return actionsIn(m).length >= 2;
}
// Which action words each capability covers, so a part of the message no step took is named, never dropped silently.
const COVERS: Record<string, string[]> = {
  "jobs.search": ["search"], "apply.queue": ["apply"], "resume.tailor": ["tailor"], "outreach.draft": ["email"], "reminder.set": ["remind"],
  "tracker.update": ["track"], "interview.prep": ["prep"], "alerts.watch": ["watch"], "instruction.remember": ["remember"],
};
// An action is covered when a step's capability does it, or when its word is inside a step's own text ("remind me
// Tuesday to prep" covers "prep": it is what the reminder is about, not a separate ask).
export function uncovered(message: string, steps: { capability: string; text?: string }[]): string[] {
  const done = new Set(steps.flatMap((s) => COVERS[s.capability] ?? []));
  const inside = new Set(steps.flatMap((s) => actionsIn(String(s.text ?? ""))));
  return actionsIn(message).filter((a) => !done.has(a) && !inside.has(a));
}

// ------------------------------------------------------------------------------------------------ owner rules
// LinkedIn, Indeed and Handshake are never fetched or automated (ported from #252 contract.ts): the label on any suffix
// and depth (indeed.co.uk, www.linkedin.cn, lnkd.in, app.joinhandshake.com); a look-alike that only contains the word
// (notindeed.com) is allowed. A step that only names the site in words ("apply on LinkedIn") is refused the same way.
const NEVER_LABELS = new Set(["linkedin", "lnkd", "licdn", "indeed", "indeedemail", "indeedmail", "joinhandshake", "handshake"]);
export function neverAutomated(host: string): boolean {
  const labels = String(host || "").toLowerCase().replace(/\.$/, "").split(".");
  return labels.slice(0, -1).some((l) => NEVER_LABELS.has(l));
}
const URLS = /\bhttps?:\/\/[^\s"'<>]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|in|cn|co|uk|ca|de|fr|jp|au)\b(?:\/[^\s"'<>]*)?/gi;
export function forbiddenTargets(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      for (const m of x.matchAll(URLS)) {
        let host = m[0];
        try { host = new URL(/^https?:/i.test(m[0]) ? m[0] : `https://${m[0]}`).hostname; } catch { /* keep raw */ }
        if (neverAutomated(host)) out.push(host);
      }
      for (const m of x.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) if (neverAutomated(m[1])) out.push(m[1]);
      for (const m of x.matchAll(/\b(linkedin|indeed|handshake)\b/gi)) out.push(m[1].toLowerCase());
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(v);
  return [...new Set(out)];
}
// Provenance (#252): an address a step would act on must be in the person's own words this turn (or their contacts on
// file, which the networking path checks itself). One that appears only in third-party text can never become a recipient.
export function targetsOf(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === "string") for (const m of x.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\bhttps?:\/\/[^\s"'<>]+/g)) out.push(m[0].toLowerCase());
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(v);
  return [...new Set(out)];
}
export function untrusted(targets: string[], trusted: string[]): string[] {
  const t = trusted.join("\n").toLowerCase();
  return targets.filter((x) => !t.includes(x.toLowerCase()));
}
// A step's text must be the person's own words: every word of three or more letters in it is in their message (a step
// can drop words, never add them). This is what keeps the plan from adding an ask, a name or a day the person never said.
const words = (s: string) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9@.+#\s-]/g, " ").split(/[\s-]+/).map((w) => w.replace(/^[.]+|[.]+$/g, "")).filter((w) => w.length >= 3);
export function unsaidWords(message: string, text: string): string[] {
  const said = new Set(words(message));
  return [...new Set(words(text).filter((w) => !said.has(w)))];
}

export interface Step { capability: string; text: string; args: Record<string, unknown> }
export interface Refused { capability: string; text: string; why: "unknown_capability" | "never_automated" | "untrusted_source" | "not_their_words" | "duplicate" | "bad_args" | "over_cap"; detail?: string[] }
// Caps (review of PR #362: one message ran 40 apply turns and wrote 40 reminders). One message runs at most MAX_STEPS
// steps; every apply goes through ONE apply step (one card: later apply steps' picks join the first's, anything else is
// over the cap); at most MAX_REMINDERS reminders; at most MAX_PICKS postings per step (each tailored pick is a turn). What
// is over a cap is refused and named in the reply ("over_cap"), never run and never dropped silently. Tailoring is capped
// the same way (re-review: 7 tailor steps x 5 picks ran 35 tailoring turns): ONE tailor step, later picks join it, so
// one message tailors at most MAX_PICKS postings.
export const MAX_STEPS = 8, MAX_REMINDERS = 3, MAX_PICKS = 5;
export const PER_TYPE: Readonly<Record<string, number>> = { "apply.queue": 1, "resume.tailor": 1, "reminder.set": MAX_REMINDERS };
// The capabilities whose later steps' picks join the first step's (positions on the same list).
const JOIN_PICKS = new Set(["apply.queue", "resume.tailor"]);
export type CapKind = "steps" | "apply.queue" | "resume.tailor" | "reminder.set" | "picks";
// Code checks every step the model proposed; a refused step is named in the reply, never run.
export function checkPlan(raw: unknown, message: string): { kind: "task" | "not_a_task"; steps: Step[]; refused: Refused[] } {
  const u: any = raw && typeof raw === "object" ? raw : {};
  if (u.kind !== "task" || !Array.isArray(u.steps) || !u.steps.length) return { kind: "not_a_task", steps: [], refused: [] };
  const steps: Step[] = [], refused: Refused[] = [];
  const seen = new Set<string>();
  for (const s of u.steps as any[]) {
    const name = String(s?.capability ?? ""), text = String(s?.text ?? "").trim().slice(0, 400);
    const args = s?.args && typeof s.args === "object" && !Array.isArray(s.args) ? s.args as Record<string, unknown> : {};
    const cap = capability(name);
    if (!cap) { refused.push({ capability: name, text, why: "unknown_capability" }); continue; }
    const never = forbiddenTargets({ text, args });
    if (never.length) { refused.push({ capability: name, text, why: "never_automated", detail: never }); continue; }
    const bad = untrusted(targetsOf({ text, args }), [message]);
    if (bad.length) { refused.push({ capability: name, text, why: "untrusted_source", detail: bad }); continue; }
    const unsaid = unsaidWords(message, text);
    if (!text || unsaid.length) { refused.push({ capability: name, text, why: "not_their_words", detail: unsaid.slice(0, 8) }); continue; }
    if (args.picks !== undefined && !(Array.isArray(args.picks) && args.picks.length && args.picks.every((n) => Number.isInteger(n) && (n as number) >= 1))) {
      refused.push({ capability: name, text, why: "bad_args", detail: ["picks"] }); continue;
    }
    const key = `${name}|${text.toLowerCase()}|${JSON.stringify(args)}`;
    if (seen.has(key)) { refused.push({ capability: name, text, why: "duplicate" }); continue; }
    seen.add(key);
    // Applies are one card and tailoring one step: a later step's picks join the first such step's (the same list).
    const first = JOIN_PICKS.has(name) ? steps.find((x) => x.capability === name) : undefined;
    if (first && Array.isArray(first.args.picks) && Array.isArray(args.picks)) {
      first.args = { ...first.args, picks: [...new Set([...(first.args.picks as number[]), ...(args.picks as number[])])] };
      first.text = `${first.text}; ${text}`.slice(0, 400);
    } else if ((PER_TYPE[name] ?? Infinity) <= steps.filter((x) => x.capability === name).length) {
      refused.push({ capability: name, text, why: "over_cap", detail: [name] }); continue;
    } else if (steps.length >= MAX_STEPS) {
      refused.push({ capability: name, text, why: "over_cap", detail: ["steps"] }); continue;
    } else steps.push({ capability: name, text, args });
  }
  // A step's picks past MAX_PICKS are named, never run.
  for (const st of steps) {
    const picks = st.args.picks;
    if (Array.isArray(picks) && picks.length > MAX_PICKS) {
      st.args = { ...st.args, picks: picks.slice(0, MAX_PICKS) };
      refused.push({ capability: st.capability, text: st.text, why: "over_cap", detail: ["picks", ...picks.slice(MAX_PICKS).map(String)] });
    }
  }
  return { kind: "task", steps, refused };
}

// ------------------------------------------------------------------------------------------------ reminder days
// A reminder's day, from the person's own words only ("Friday", "Tuesday", "tomorrow", "in a week", "in 3 days", "next
// week", "on 2026-11-06"), counted from today in their time zone. Anything else is not a day and nothing is set.
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export function localDate(now: number, tz: string | null): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now)); }
  catch { return new Date(now).toISOString().slice(0, 10); }
}
const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function dueDate(when: string, now: number, tz: string | null): string | null {
  const w = String(when ?? "").toLowerCase().trim();
  const today = localDate(now, tz);
  const iso = /\b(20\d\d-\d\d-\d\d)\b/.exec(w);
  if (iso) return iso[1] >= today ? iso[1] : null;
  if (/\btomorrow\b/.test(w)) return addDays(today, 1);
  if (/\btoday\b|\btonight\b/.test(w)) return today;
  const n = /\bin (a|an|one|two|three|four|five|six|seven|\d{1,3}) (day|week)s?\b/.exec(w);
  if (n) {
    const k = ({ a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 } as Record<string, number>)[n[1]] ?? Number(n[1]);
    return addDays(today, k * (n[2] === "week" ? 7 : 1));
  }
  if (/\bnext week\b/.test(w)) return addDays(today, 7);
  const day = DAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(w));
  if (day >= 0) {
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    const k = (day - dow + 7) % 7;
    return addDays(today, k === 0 ? 7 : k); // "Friday" said on a Friday is the next one

  }
  return null;
}
