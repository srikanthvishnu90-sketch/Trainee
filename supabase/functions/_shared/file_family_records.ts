// Item 6, S5 (task f-s5): seven File families and the F-14n negotiation variant drawn from the person's real records, read when the page is served, never from a
// stored copy. F-01 Career brief, F-02 Profile facts, F-03 Path comparison, F-08 Answer library, F-13 Interview hub, F-14 Weekly
// brief, F-15 Offer comparison. Each view is the input of the family's own builder (file_family_plan.ts, file_family_apply.ts).
//
// Where each family reads from (nothing else, and nothing a model wrote):
//   the account record   career_watch_kv 'career:account': the confirmed resume entries (memory.profile.facts, status confirmed)
//                        and the facts the person stated in chat (stated_facts, written only from their own words).
//   standing             career_watch_kv 'career:standing': instructions the person gave in their own words.
//   questions            career_apply_questions: the employers' questions and the answers the person gave.
//   interviews           career_interviews: invites read from mail or told in chat, with the time only as the invite stated it.
//   digest               career_digest_prefs: whether the weekly brief is on, its day and hour.
//   events               career_events of the last 7 days: what actually happened.
//   offers               each thread's offers on file (agent_flow_state ... stores.offerBenchmark.offers), the person's own words.
// Rules: a value the person hasn't given is drawn "Unknown" by name, never guessed (D-007). A time the invite did not state is not
// a booking ("suggested is not booked"). Nothing here accepts, books or sends anything; a decision opens the chat with the question
// filled in, and the one state change (pausing the weekly brief) is a POST with the page token (file_family_actions.ts).
// With no record to draw from, a family is a C.24 state page saying what is missing and what to tell Trainee; never an invented File.
import type { Act, KV, Src, StateInput } from "./file_family.ts";
import type { AnswerLibrary, CareerBrief, PathComparison, ProfileFact, ProfileFacts } from "./file_family_plan.ts";
import type { InterviewHub, Negotiation, OfferComparison, WeeklyBrief } from "./file_family_apply.ts";

export type LiveFamily = "F-01" | "F-02" | "F-03" | "F-08" | "F-13" | "F-14" | "F-14n" | "F-15";
export const LIVE_FAMILIES: LiveFamily[] = ["F-01", "F-02", "F-03", "F-08", "F-13", "F-14", "F-14n", "F-15"];
export const isLiveFamily = (x: unknown): x is LiveFamily => typeof x === "string" && (LIVE_FAMILIES as string[]).includes(x);

export interface QuestionRow { key: string; kind: string; label: string; company: string | null; state: string; answer: string | null; answered_at: string | null }
export interface InterviewRow {
  company: string | null; role: string | null; source: string; when_said: unknown[]; interview_date: string | null; interview_time: string | null; zone: string | null;
  starts_at: string | null; format: string | null; interviewers: { name?: string; title?: string | null }[]; seen_at: string;
}
export interface OfferOnFile { offer: { company: string | null; role: string | null; base: number | null; signing: number | null; bonus: number | null; bonus_pct: number | null; city: string | null; remote?: boolean; deadline: { text: string } | null }; equity: string | null; said: string; at: number }
export interface Records {
  now: number; tz: string | null;
  // deno-lint-ignore no-explicit-any
  account: any | null; standing: { text: string; at?: string }[]; questions: QuestionRow[]; interviews: InterviewRow[];
  digest: { enabled: boolean; day: number; hour: number; tz: string | null } | null; events: { at: string; kind: string; subject: string | null }[]; offers: OfferOnFile[];
}
// What each family reads: the reader fetches only these.
export type Source = "account" | "standing" | "questions" | "interviews" | "digest" | "events" | "offers";
export const READS: Record<LiveFamily, Source[]> = {
  "F-01": ["account", "standing", "events"], "F-02": ["account", "standing"], "F-03": ["account"], "F-08": ["questions"],
  "F-13": ["interviews"], "F-14": ["digest", "events", "questions", "interviews"], "F-14n": ["offers"], "F-15": ["offers"],
};
export type FamilyView = { view: unknown } | { state: StateInput };

// The chat links: each opens the chat with the question filled in (file_family_serve.ts ASK_KEYS turns ?<key>= into that link).
const ask = (key: string, label: string, aria?: string): Act => ({ label, effect: "decide", href: `?${key}=1`, ...(aria ? { aria } : {}) });
const iso = (t: unknown): string | null => {
  const n = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
const clean = (s: unknown, max = 160) => typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";
const SAID = (at: unknown): Src => ({ label: "You said in chat", at: iso(at) });
const missingState = (family: Exclude<LiveFamily, "F-14n">, title: string, name: string, why: string, next: Act): FamilyView => ({ state: { state: "needs_input", family, title, field: { name, why }, next } });

// ---------------------------------------------------------------- the person's own facts (account record)
// The stated-fact kinds a File may show, with their label. Sponsorship, citizenship and graduation year are sensitive: they are
// answered per application and never listed for reuse (F-02's and F-08's sensitive tiles say so).
const STATED: Record<string, string> = { level: "Target level", geography: "Location", target_firm: "Target firms", school: "School", majors: "Major", experience: "Experience", excluded_level: "Not interested in", tone: "Message tone" };
const ALWAYS = ["level", "geography", "target_firm", "school", "majors"]; // drawn "Unknown" by name when the person hasn't said
const SENSITIVE = new Set(["sponsorship", "citizenship", "year"]);
// deno-lint-ignore no-explicit-any
function statedOf(account: any): Map<string, { v: string; at: unknown }> {
  const a = account?.stated_facts, out = new Map<string, { v: string; at: unknown }>();
  for (const f of [...(Array.isArray(a?.facts) ? a.facts : []), ...(Array.isArray(a?.keyed) ? a.keyed : [])]) {
    const k = clean(f?.kind, 40), v = clean(f?.value);
    if (!k || !v || SENSITIVE.has(k) || !STATED[k]) continue;
    const had = out.get(k);
    if (!had) out.set(k, { v, at: f.at });
    else if (!had.v.toLowerCase().split(", ").includes(v.toLowerCase())) out.set(k, { v: `${had.v}, ${v}`, at: (Date.parse(String(f.at)) || 0) > (Date.parse(String(had.at)) || 0) ? f.at : had.at });
  }
  return out;
}
// The resume's confirmed entries and its drafts (the same filter as career_account_memory.ts recordLines).
// deno-lint-ignore no-explicit-any
function resumeOf(account: any): { confirmed: ProfileFact[]; drafts: ProfileFact[] } {
  const p = account?.memory?.profile, facts = Array.isArray(p?.facts) && !p._fromStatedFacts ? p.facts : [];
  // deno-lint-ignore no-explicit-any
  const name = (f: any) => clean(String(f.title || f.text || "").split("\n")[0], 90);
  // deno-lint-ignore no-explicit-any
  const label = (f: any) => { const k = clean(f.kind, 30) || "entry"; return k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "); };
  // deno-lint-ignore no-explicit-any
  const confirmed = facts.filter((f: any) => f && f.status === "confirmed" && f.needs_confirmation !== true && name(f)).slice(0, 30)
    // deno-lint-ignore no-explicit-any
    .map((f: any): ProfileFact => ({ k: label(f), v: name(f), kind: "confirmed", src: { label: "Your resume, confirmed by you", at: iso(f.confirmed_at) } }));
  // deno-lint-ignore no-explicit-any
  const drafts = facts.filter((f: any) => f && f.needs_confirmation === true && name(f)).slice(0, 10)
    // deno-lint-ignore no-explicit-any
    .map((f: any): ProfileFact => ({ k: `${label(f)} (draft)`, v: `${name(f)} - never used until you confirm it`, kind: "unknown", src: { label: "Read from your resume, not confirmed" } }));
  return { confirmed, drafts };
}

// ---------------------------------------------------------------- F-02 Profile facts
export function profileFactsView(r: Records): FamilyView {
  const stated = statedOf(r.account), resume = resumeOf(r.account);
  const facts: ProfileFact[] = [];
  for (const k of [...ALWAYS, ...Object.keys(STATED).filter((x) => !ALWAYS.includes(x))]) {
    const s = stated.get(k);
    if (s) facts.push({ k: STATED[k], v: s.v, kind: "confirmed", src: SAID(s.at) });
    else if (ALWAYS.includes(k)) facts.push({ k: STATED[k], v: null, kind: "unknown", src: null });
  }
  for (const s of r.standing.slice(0, 10)) facts.push({ k: "Standing instruction", v: clean(s.text), kind: "confirmed", src: SAID(s.at) });
  facts.push(...resume.confirmed, ...resume.drafts);
  const d: ProfileFacts = { facts, acts: { primary: ask("correct", "Correct a fact"), secondary: [ask("add", "Tell Trainee something new")], caption: "Correcting a fact here opens the chat; nothing changes until you say it there." } };
  return { view: d };
}

// ---------------------------------------------------------------- F-01 Career brief
export function careerBriefView(r: Records): FamilyView {
  const stated = statedOf(r.account), resume = resumeOf(r.account), v = (k: string) => stated.get(k)?.v ?? null;
  const level = v("level"), firms = v("target_firm"), where = v("geography");
  const aim = level ? { text: `${level} roles${firms ? ` at ${firms}` : ""}`, detail: where ? `In ${where}.` : null, provisional: false }
    : { text: "Not set yet", detail: "Trainee hasn't been told what you're aiming for.", provisional: false };
  const constraints = [where ? `Location: ${where}` : null, v("excluded_level") ? `Not: ${v("excluded_level")}` : null, ...r.standing.slice(0, 5).map((s) => clean(s.text, 80))].filter((x): x is string => !!x);
  const questions: CareerBrief["questions"] = [];
  if (!level) questions.push({ q: "What role are you aiming for?", why: "Searches and materials are shaped by it. Until you say, nothing assumes a level.", act: ask("answer", "Answer in chat", "Answer what role you're aiming for in the chat") });
  if (!where) questions.push({ q: "Where do you want to work?", why: "Location filters every search. Relocation is never assumed.", act: ask("answer", "Answer in chat", "Answer where you want to work in the chat") });
  const searched = r.events.some((e) => e.kind === "search");
  const first = [{ done: resume.confirmed.length > 0, text: "Confirm your resume" }, { done: !!level, text: "Say the role you're aiming for" }, { done: searched, text: "Run a first search" }];
  const at = r.account?.stated_facts?.updated_at ?? null;
  const sources = [resume.confirmed.length ? "your confirmed resume" : null, stated.size || r.standing.length ? "your words in chat" : null].filter(Boolean).join(" and ") || null;
  const d: CareerBrief = { version: Math.max(1, Number(r.account?.version) || 1), title: "Your career brief", updatedAt: iso(at), sources: sources && sources.charAt(0).toUpperCase() + sources.slice(1),
    aim, constraints, questions, first, acts: { primary: ask("correct", "Correct something"), secondary: [ask("plan", "Plan my next step")] } };
  return { view: d };
}

// ---------------------------------------------------------------- F-03 Path comparison
// No record of compared directions exists anywhere yet (the brain keeps none). Evidence strength and reach are never made up, so
// the page says so and opens the chat. It draws a comparison as soon as a store of directions does.
export function pathComparisonView(_r: Records): FamilyView {
  return missingState("F-03", "No path comparison on record", "What's missing", "Trainee compares directions only from facts you confirmed, and no comparison has been made for you yet. Hiring odds are never predicted.", ask("start", "Ask Trainee to compare two directions"));
}

// ---------------------------------------------------------------- F-08 Answer library
const SENSITIVE_Q = /sponsor|visa|authori[sz]|citizen|gender|race|ethnic|disab|veteran|pronoun|sexual|graduat|gpa|date of birth|age\b/i;
export function answerLibraryView(r: Records): FamilyView {
  const qs = r.questions, answered = qs.filter((q) => q.state === "answered" && q.answer && !SENSITIVE_Q.test(q.label) && !["screen", "consent", "attestation"].includes(q.kind));
  const factual: KV[] = answered.filter((q) => q.kind === "fact" || q.kind === "derived").slice(0, 40).map((q) => ({ k: clean(q.label, 120), v: clean(q.answer, 300), src: { label: "You answered", at: iso(q.answered_at) } }));
  const roleSpecific = answered.filter((q) => q.kind === "essay").slice(0, 20).map((q) => ({ q: clean(q.label, 160), scope: q.company ? clean(q.company, 60) : "One posting", note: "Your answer for this employer only. Another employer's question is asked again, not filled from this." }));
  const decl = qs.find((q) => q.kind === "attestation" && q.state === "open");
  const needed = qs.filter((q) => q.state === "open").length;
  if (!factual.length && !roleSpecific.length && !decl && !needed) return missingState("F-08", "No saved answers yet", "What's missing", "Answers appear here after you answer an employer's question. None has been asked or answered yet.", ask("start", "Ask Trainee how answers are reused"));
  const d: AnswerLibrary = { declaration: decl ? { rid: decl.company ? clean(decl.company, 60) : "a posting", text: clean(decl.label, 300) } : null,
    factual: factual.length ? factual : [{ k: "Saved answers", v: null, missing: "None saved yet" }], roleSpecific, scoped: [], needed,
    acts: { primary: needed ? ask("answer", `Answer ${needed} open ${needed === 1 ? "question" : "questions"}`) : ask("edit", "Change a saved answer"), secondary: needed ? [ask("edit", "Change a saved answer")] : [] } };
  return { view: d };
}

// ---------------------------------------------------------------- F-13 Interview hub
const MEDIUM: Record<string, string> = { video: "Video", phone: "Phone", onsite: "On site", "recorded video": "Recorded video", superday: "Superday" };
export function interviewHubView(r: Records): FamilyView {
  const timed = r.interviews.filter((i) => i.starts_at && Date.parse(i.starts_at) >= r.now - 3600_000).sort((a, b) => Date.parse(a.starts_at!) - Date.parse(b.starts_at!));
  const i = timed[0];
  if (!i) {
    const untimed = r.interviews.filter((x) => !x.starts_at).sort((a, b) => Date.parse(b.seen_at) - Date.parse(a.seen_at))[0];
    if (untimed) return missingState("F-13", `Interview with ${clean(untimed.company, 60) || "an employer"}: no time on record`, "Suggested is not booked", `${untimed.interview_date ? `The invite names ${untimed.interview_date} but no time and zone.` : "The invite names no date and time."} Nothing is booked until the employer confirms a time.`, ask("answer", "Tell Trainee the time"));
    return missingState("F-13", "No upcoming interview on record", "What's missing", "Interviews appear here from an invite in your connected mail or when you tell Trainee about one.", ask("start", "Tell Trainee about an interview"));
  }
  const options = Array.isArray(i.when_said) ? i.when_said.length : 0, who = i.interviewers.find((x) => clean(x?.name));
  const name = clean(who?.name, 60), initials = name ? name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() : "?";
  const company = clean(i.company, 60) || "Employer not stated", booked = options <= 1;
  const d: InterviewHub = { company, stage: clean(i.role, 60) || "Interview", at: i.starts_at!, tz: r.tz ?? i.zone ?? "America/Chicago", interviewerTz: r.tz && i.zone && i.zone !== r.tz ? i.zone : null,
    minutes: null, medium: MEDIUM[i.format ?? ""] ?? "Format not stated", booked, calendarVerified: false,
    person: name ? { initials, name, role: clean(who?.title, 60) || "title not stated", verified: false, basis: `Named in the ${i.source === "mail" ? "invite email" : "chat"}; not checked against another source.` }
      : { initials, name: "Not named", role: "the invite names no interviewer", verified: false, basis: "Nobody is named, so nobody is guessed." },
    prep: [...(booked ? [] : [{ done: false, lead: "Not booked:", text: `The invite offers ${options} times. Pick one and confirm it with ${company}.` }]), { done: false, text: `Practice one question for this ${clean(i.role, 60) || "interview"}.` }],
    acts: { primary: ask("practice", "Practice for this interview"), secondary: [ask("questions", "Questions to ask them")] } };
  return { view: d };
}

// ---------------------------------------------------------------- F-14 Weekly brief
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EVENT: Record<string, [string, string]> = { application_approved: ["application approved", "applications approved"], application_finished: ["application finished", "applications finished"],
  apply_queued: ["application queued", "applications queued"], search: ["search run", "searches run"], outreach_sent: ["message sent", "messages sent"], outreach_replied: ["reply received", "replies received"],
  intro_made: ["introduction made", "introductions made"], mock_done: ["practice session done", "practice sessions done"], fact_confirmed: ["fact confirmed", "facts confirmed"] };
export function weeklyBriefView(r: Records, token: string | null): FamilyView {
  const since = r.now - 7 * 86400_000, week = new Date(since).toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const e of r.events) if (Date.parse(e.at) >= since && EVENT[e.kind]) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const changed = [...counts].map(([k, n]) => `${n} ${EVENT[k][n === 1 ? 0 : 1]}`);
  const open = r.questions.filter((q) => q.state === "open").length;
  const soon = r.interviews.filter((i) => i.starts_at && Date.parse(i.starts_at) >= r.now && Date.parse(i.starts_at) < r.now + 7 * 86400_000);
  const decisions: WeeklyBrief["decisions"] = [];
  if (open) decisions.push({ title: `${open} employer ${open === 1 ? "question" : "questions"} waiting`, text: "The applications that ask them wait until you answer. Nothing is guessed.", act: ask("answer", "Answer in chat") });
  for (const i of soon.slice(0, 3)) decisions.push({ title: `Interview with ${clean(i.company, 60) || "an employer"}`, text: `${i.when_said?.length > 1 ? "Suggested times, not booked yet." : "On the time the invite stated."} Prepare or ask what to expect.`, act: ask("practice", "Practice") });
  const blockers = open ? [`${open} ${open === 1 ? "application is" : "applications are"} held for your answers.`] : [];
  const g = r.digest, on = g ? g.enabled : true, cadence = g ? (on ? `Weekly, ${DAY[g.day] ?? "Sunday"} ${g.hour}:00` : "Paused") : "Weekly, Sunday 18:00 (the default)";
  const pause: Act | null = token ? (on ? { label: "Pause the weekly brief", effect: "danger", post: { token, action: "briefpause" }, aria: "Pause the weekly brief. Your records are kept." } : { label: "Resume the weekly brief", effect: "decide", post: { token, action: "briefresume" } })
    : { label: on ? "Pause the weekly brief" : "Resume the weekly brief", effect: "decide", off: "This page has no sign-in token, so it can't change anything." };
  const d: WeeklyBrief = { week, n: null, generatedAt: new Date(r.now).toISOString(), cadence, changed, decisions, blockers,
    acts: { primary: pause, secondary: [ask("plan", "Plan my week")], caption: "Pausing keeps every record. Nothing new is sent to you until you resume." } };
  return { view: d };
}

// ---------------------------------------------------------------- F-15 Offer comparison
const money = (n: number | null | undefined) => typeof n === "number" && Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : null;
export function offerComparisonView(r: Records): FamilyView {
  const byCo = new Map<string, OfferOnFile>();
  for (const o of r.offers) { const k = clean(o?.offer?.company, 80).toLowerCase(); if (!k) continue; const had = byCo.get(k); if (!had || o.at > had.at) byCo.set(k, o); }
  const list = [...byCo.values()].sort((a, b) => b.at - a.at).slice(0, 4);
  if (!list.length) return missingState("F-15", "No offer on record", "Nothing accepted", "An offer appears here once you tell Trainee its terms. Nothing has been accepted, declined or sent.", ask("start", "Tell Trainee about an offer"));
  const rows = (o: OfferOnFile): KV[] => {
    const s = SAID(o.at), x = o.offer, row = (k: string, v: string | null, missing = "Not stated"): KV => ({ k, v, src: v ? s : null, missing });
    return [row("Role", clean(x.role, 80) || null), row("Base salary", money(x.base)), row("Signing bonus", money(x.signing)),
      row("Annual bonus", money(x.bonus) ?? (typeof x.bonus_pct === "number" ? `${x.bonus_pct}% target` : null)), row("Equity (never added to cash)", clean(o.equity, 120) || null),
      row("Location", x.remote ? "Remote" : clean(x.city, 60) || null), row("Deadline", clean(x.deadline?.text, 60) || null)];
  };
  const withDeadline = list.find((o) => clean(o.offer.deadline?.text));
  const d: OfferComparison = { offers: list.map((o, i) => ({ letter: String.fromCharCode(65 + i), company: clean(o.offer.company, 60), rows: rows(o) })),
    deadline: { company: clean((withDeadline ?? list[0]).offer.company, 60), at: null, text: withDeadline ? clean(withDeadline.offer.deadline!.text, 60) : "not stated" },
    priorities: null, basis: "from your words in chat",
    acts: { primary: ask("priorities", "Compare with my priorities"), secondary: [ask("negotiate", "Plan a counter"), ask("decision", "Talk through the decision")], caption: "Nothing here accepts, declines or sends anything." } };
  return { view: d };
}

// ---------------------------------------------------------------- F-14n Negotiation plan (the F-14 variant)
// From the newest offer on file. What the person told Trainee in chat is drawn as verbal (it is not a written term); their position
// (walk-away number, what matters most) is Unknown until they say it; no counter is drafted here, and no competing offer, deadline or
// acceptance intent is added (E-77). Approving nothing here sends anything: the counter goes through the message review (F-12).
export function negotiationView(r: Records): FamilyView {
  const newest = [...r.offers].filter((o) => clean(o?.offer?.company)).sort((a, b) => b.at - a.at)[0];
  if (!newest) return missingState("F-14", "No offer to plan a negotiation for", "Nothing accepted", "A negotiation plan starts from an offer you tell Trainee about. None is on record, and nothing has been accepted or sent.", ask("start", "Tell Trainee about an offer"));
  const x = newest.offer, company = clean(x.company, 60);
  const terms = [x.role ? clean(x.role, 60) : null, money(x.base) ? `base ${money(x.base)}` : null, money(x.signing) ? `signing ${money(x.signing)}` : null,
    money(x.bonus) ? `bonus ${money(x.bonus)}` : typeof x.bonus_pct === "number" ? `bonus ${x.bonus_pct}% target` : null, clean(newest.equity, 80) ? `equity ${clean(newest.equity, 80)}` : null].filter(Boolean).join(", ");
  const d: Negotiation = { company, v: null, deadline: null, basis: "your words in chat",
    position: [{ k: "Walk-away number", v: null, missing: "Unknown - you haven't said" }, { k: "What matters most", v: null, missing: "Unknown - you haven't said" },
      { k: "Deadline", v: clean(x.deadline?.text, 60) || null, src: clean(x.deadline?.text) ? SAID(newest.at) : null, missing: "Not stated" }],
    history: [{ v: `As you told it (${iso(newest.at)?.slice(0, 10) ?? "date unknown"})`, written: false, text: terms || "Terms not stated" }],
    ask: { title: "No counter drafted yet", text: "Trainee drafts one only when you ask, from the terms you gave.", act: ask("negotiate", "Ask Trainee to draft a counter") },
    acts: { primary: ask("priorities", "Tell Trainee what matters most"), secondary: [ask("decision", "Talk through the decision")], caption: "Nothing here accepts, declines or sends anything." } };
  return { view: d };
}

export function viewOf(family: LiveFamily, r: Records, o: { token?: string | null } = {}): FamilyView {
  switch (family) {
    case "F-01": return careerBriefView(r);
    case "F-02": return profileFactsView(r);
    case "F-03": return pathComparisonView(r);
    case "F-08": return answerLibraryView(r);
    case "F-13": return interviewHubView(r);
    case "F-14": return weeklyBriefView(r, o.token ?? null);
    case "F-14n": return negotiationView(r);
    case "F-15": return offerComparisonView(r);
  }
}

// ---------------------------------------------------------------- the reader over Supabase (service role, keyed by the person)
// Every read is the person's own rows. An unreadable source throws: the page then draws the C.24 error state, never a File built
// from part of the records.
// deno-lint-ignore no-explicit-any
export function supabaseRecords(admin: any): (userId: string, family: LiveFamily, o: { now: number; tz: string | null }) => Promise<Records> {
  return async (userId, family, o) => {
    const need = new Set(READS[family]);
    // deno-lint-ignore no-explicit-any
    const must = (r: any, what: string) => { if (r.error) throw new Error(`read ${what}: ${r.error.message}`); return r.data; };
    const kv = need.has("account") || need.has("standing") ? must(await admin.from("career_watch_kv").select("key,value").eq("user_id", userId).in("key", ["career:account", "career:standing"]), "the account") ?? [] : [];
    // deno-lint-ignore no-explicit-any
    const val = (k: string) => kv.find((x: any) => x.key === k)?.value ?? null;
    const standing = Array.isArray(val("career:standing")?.items) ? val("career:standing").items.filter((x: { text?: unknown }) => typeof x?.text === "string") : [];
    const questions = need.has("questions") ? must(await admin.from("career_apply_questions").select("key,kind,label,company,state,answer,answered_at").eq("user_id", userId).order("updated_at", { ascending: false }).limit(200), "the employer questions") ?? [] : [];
    const interviews = need.has("interviews") ? must(await admin.from("career_interviews").select("company,role,source,when_said,interview_date,interview_time,zone,starts_at,format,interviewers,seen_at").eq("user_id", userId).order("seen_at", { ascending: false }).limit(50), "the interviews") ?? [] : [];
    const digest = need.has("digest") ? must(await admin.from("career_digest_prefs").select("enabled,day,hour,tz").eq("user_id", userId).maybeSingle(), "the weekly brief setting") : null;
    const events = need.has("events") ? must(await admin.from("career_events").select("at,kind,subject").eq("user_id", userId).gte("at", new Date(o.now - 7 * 86400_000).toISOString()).order("at", { ascending: false }).limit(500), "this week's events") ?? [] : [];
    const offers = need.has("offers") ? (must(await admin.from("agent_flow_state").select("offers:state->career->stores->offerBenchmark->offers").eq("user_id", userId).limit(200), "the offers on file") ?? [])
      // deno-lint-ignore no-explicit-any
      .flatMap((t: any) => Array.isArray(t?.offers) ? t.offers : []).filter((x: OfferOnFile) => x && x.offer && typeof x.at === "number") : [];
    return { now: o.now, tz: o.tz, account: val("career:account"), standing, questions, interviews, digest: digest ?? null, events, offers };
  };
}
