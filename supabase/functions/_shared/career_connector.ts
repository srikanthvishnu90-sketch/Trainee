// WO-026: the Connector. Trainee keeps an opt-in network of its users (and opted-in mentors, alumni and recruiters) and
// brokers double-opt-in warm introductions, one at a time, for career reasons only: a student meets an alum at a firm
// they want, candidates swap what interviews were like, a job seeker meets someone who can refer them, peers prep
// together. Code decides who is proposed and what anyone is told; the model never does.
//
// Consent is load-bearing (one consent violation is a launch-blocking bug):
//   - Nobody is matched who has not opted in, or who paused or left.
//   - Nothing identifying about either person (name, contact, id, any fact the match does not rest on) reaches the other
//     until BOTH said yes to THAT introduction. Before that, each side reads the other's role kind and the one-line why,
//     which states only the needs, offers and shared facts the match rests on.
//   - Every why cites real facts from both profiles: no fact, no intro (score() returns nothing without them, and the
//     database refuses a proposal whose cites are not in both stored profiles).
//   - One pending proposal per person, at most 3 proposals in 7 days, a pair once ever, never below the fit bar to hit a
//     number. A block (either way) stops proposals for good; a report also hides the reporter from the reported person.
//   - No directory and no search by name: "connect me with <a name>" is refused, and nothing lists people.
//   - A "yes" or "no" counts only while the proposal is the thread's last word (the cards rule, WO-022). "stop" is never a
//     command here: it is the carrier's opt-out word.
// The network opens only with CONNECTOR_ENABLED=on and 500 opted-in, unpaused profiles (cold start). With the flag on and
// fewer than 500, people can join and say what they need and offer, and nothing is proposed.
//
// Pure functions first (profileFrom, score, proposeNext, introText, checkins, applyFeedback), then connectorTurn, which
// runs before the brain and returns null when the text is not for it. Not wired into handler-career.ts yet (WO-026).

export type Role = "student" | "candidate" | "mentor" | "alumni" | "recruiter";
export type NeedKind = "meet" | "intel" | "referral" | "prep";
export type OfferKind = "advice" | "intel" | "referral";
export const ROLES: Role[] = ["student", "candidate", "mentor", "alumni", "recruiter"];
export const VERIFY_ROLES: Role[] = ["mentor", "recruiter"];

// One fact, need or offer on a match profile: its own stable id, what it says, and where it came from.
export interface Item { id: string; kind: string; value: string; source: string }
export interface Filters {
  exclude_roles?: Role[];
  prefer_kinds?: NeedKind[];
  avoid_kinds?: NeedKind[];
  not_useful_roles?: Partial<Record<Role, number>>;
  min_score?: number;
}
export interface Profile {
  user_id: string;
  role: Role;
  verified: boolean;
  opted_in: boolean;
  paused: boolean;
  needs: Item[];
  offers: Item[];
  facts: Item[];
  filters: Filters;
}
export interface IntroRow {
  id: string;
  a_user: string;
  b_user: string;
  kind: NeedKind;
  state: string;
  proposed_at: string;
  decided_at?: string | null;
  intro_at?: string | null;
  nudge_at?: string | null;
  checkin_at?: string | null;
  checkin_nudge_at?: string | null;
  feedback?: Record<string, unknown>;
}
export interface BlockRow { blocker: string; blocked: string; reported?: boolean }
// What one side reads of an introduction (connector_view in the migration): never the other's id before both yes.
export interface MyIntro {
  id: string;
  kind: NeedKind;
  state: string;
  side: "a" | "b";
  why: string;
  other_role: Role | null;
  other_user: string | null;
  my_answer: "yes" | null;
  proposed_at: string;
  intro_at?: string | null;
  my_feedback?: unknown;
}

export const FIT_BAR = 3; // one real need met by a real offer
export const WEEKLY_CAP = 3;
export const MIN_NETWORK = 500;
export const FOLLOW_MS = 72 * 3600000;
const WEEK_MS = 7 * 86400000;
export const PENDING = ["proposed", "a_yes", "b_yes"];
export const INTRODUCED = ["introduced", "met", "no_meeting", "no_reply"];
const AFTER_BOTH_YES = ["both_yes", ...INTRODUCED];

export const PROPOSAL_INTENT = "connector_proposal";
export const INTRO_INTENT = "connector_intro";
export const CHECKIN_INTENT = "connector_checkin";
export const TIMES_INTENT = "connector_times";
export const CONNECTOR_INTENT = "connector";

// ---------------------------------------------------------------- words

const clean = (s: unknown, max = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
export const plain = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const slug = (s: unknown) => plain(s).replace(/ /g, "-").slice(0, 60);

// Firm names people text, to one name. Only well-known short forms; anything else is kept as the person wrote it.
const FIRMS: Record<string, string> = {
  "jpm": "JPMorgan", "jp morgan": "JPMorgan", "j p morgan": "JPMorgan", "jpmorgan": "JPMorgan", "jpmorgan chase": "JPMorgan",
  "jp morgan chase": "JPMorgan", "jpmc": "JPMorgan", "goldman": "Goldman Sachs", "goldman sachs": "Goldman Sachs",
  "morgan stanley": "Morgan Stanley", "bofa": "Bank of America", "bank of america": "Bank of America",
  "citi": "Citi", "citigroup": "Citi", "citibank": "Citi", "mckinsey": "McKinsey", "bcg": "BCG",
  "boston consulting group": "BCG", "bain": "Bain", "google": "Google", "alphabet": "Google", "meta": "Meta",
  "facebook": "Meta", "amazon": "Amazon", "microsoft": "Microsoft", "deloitte": "Deloitte", "pwc": "PwC", "ey": "EY",
  "ernst and young": "EY", "kpmg": "KPMG", "blackrock": "BlackRock", "evercore": "Evercore", "lazard": "Lazard",
};
export function firmName(s: unknown): string {
  const words = clean(s, 120).replace(/[.,!?]+$/, "");
  const p = plain(words).replace(/^the /, "").replace(/ (inc|llc|ltd|corp|corporation|group|and co|co)$/, "");
  return FIRMS[p] ?? words;
}
const sameFirm = (x: string, y: string) => plain(firmName(x)) === plain(firmName(y));
const sameText = (x: string, y: string) => plain(x) === plain(y);

// ---------------------------------------------------------------- 1. the match profile

// A fact the person stated (the account's stated facts: {kind, value, evidence}) or confirmed. Anything else is left out.
export interface StatedFact { kind: string; value: string; evidence?: string | null; confirmed?: boolean }
// Career data Trainee already holds (the master profile's shape, 122-career-profile.js).
export interface CareerData {
  basics?: { name?: string | null };
  preferences?: { targetCompanies?: string[]; roles?: string[] };
  facts?: {
    id: string; kind: string; title?: string; text?: string; school?: string; institution?: string; company?: string;
    org?: string; employer?: string; needs_confirmation?: boolean; status?: string;
  }[];
}
const FACT_KINDS = new Set(["school", "employer", "target_firm", "target_role", "name"]);

export function profileFrom(stated: StatedFact[], career: CareerData | null): { facts: Item[] } {
  const out: Item[] = [];
  const add = (kind: string, value: unknown, source: string) => {
    const v = kind === "employer" || kind === "target_firm" ? firmName(value) : clean(value, 120);
    if (!v || !FACT_KINDS.has(kind)) return;
    const id = kind === "name" ? "name" : `${kind}:${slug(v)}`;
    if (!out.some((f) => f.id === id)) out.push({ id, kind, value: v, source: clean(source, 400) });
  };
  for (const f of stated ?? []) {
    const said = clean(f?.evidence, 300);
    if (!said && f?.confirmed !== true) continue; // not stated in their words, not confirmed: not used
    add(String(f.kind), f.value, said ? `chat: "${said}"` : "chat: confirmed");
  }
  const c = career ?? {};
  if (c.basics?.name) add("name", String(c.basics.name).split(/\s+/)[0], "career:basics.name");
  for (const t of c.preferences?.targetCompanies ?? []) add("target_firm", t, "career:preferences.targetCompanies");
  for (const r of c.preferences?.roles ?? []) add("target_role", r, "career:preferences.roles");
  for (const f of c.facts ?? []) {
    if (!f || f.needs_confirmation || f.status === "draft") continue; // a draft is not the person's fact yet
    if (f.kind === "education") add("school", f.school ?? f.institution ?? f.title, `career:${f.id}`);
    if (f.kind === "experience" && (f.company ?? f.org ?? f.employer)) add("employer", f.company ?? f.org ?? f.employer, `career:${f.id}`);
  }
  return { facts: out };
}
export function needItem(kind: NeedKind, value: string, said: string): Item {
  const v = kind === "prep" ? clean(value, 120) : firmName(value);
  return { id: `need:${kind}:${slug(v)}`, kind, value: v, source: `chat: "${clean(said, 300)}"` };
}
export function offerItem(kind: OfferKind, value: string, said: string): Item {
  const v = firmName(value);
  return { id: `offer:${kind}:${slug(v)}`, kind, value: v, source: `chat: "${clean(said, 300)}"` };
}
export function factItem(kind: string, value: string, said: string): Item {
  const v = kind === "employer" || kind === "target_firm" ? firmName(value) : clean(value, 120);
  return { id: `${kind}:${slug(v)}`, kind, value: v, source: `chat: "${clean(said, 300)}"` };
}
const withItem = (list: Item[], it: Item) => list.some((x) => x.id === it.id) ? list : [...list, it];
const merge = (a: Item[], b: Item[]) => b.reduce(withItem, a);

// ---------------------------------------------------------------- 2. the score

export interface Reason {
  kind: NeedKind | "school" | "target_firm";
  points: number;
  a: string[]; // ids from the first profile
  b: string[]; // ids from the second
  why_a: string; // said to the first person, about the second
  why_b: string; // said to the second person, about the first
}
export interface Score { score: number; kind: NeedKind; reasons: Reason[] }

const factsOf = (p: Profile, kind: string) => (p.facts ?? []).filter((f) => f.kind === kind);
const offersOf = (p: Profile, kind: string) => (p.offers ?? []).filter((f) => f.kind === kind);

// What x needs that y offers. Each reason carries the ids it rests on from both sides; nothing without them.
function served(x: Profile, y: Profile): Reason[] {
  const out: Reason[] = [];
  for (const n of x.needs ?? []) {
    if (n.kind === "meet") {
      const job = factsOf(y, "employer").find((f) => sameFirm(f.value, n.value));
      const off = offersOf(y, "advice").find((o) => sameFirm(o.value, n.value));
      if (job && off) {
        out.push({
          kind: "meet", points: 3, a: [n.id], b: [job.id, off.id],
          why_a: `you asked to meet someone at ${n.value}, and they work there and offered to talk about it`,
          why_b: `they want to meet someone at ${n.value}, and you offered to talk about your work there`,
        });
      }
    } else if (n.kind === "intel") {
      const off = offersOf(y, "intel").find((o) => sameFirm(o.value, n.value));
      if (off) {
        out.push({
          kind: "intel", points: 3, a: [n.id], b: [off.id],
          why_a: `you want to know how ${n.value} interviews go, and they offered to share what theirs were like`,
          why_b: `they want to hear how ${n.value} interviews go, and you offered to share yours`,
        });
      }
    } else if (n.kind === "referral") {
      const job = factsOf(y, "employer").find((f) => sameFirm(f.value, n.value));
      const off = offersOf(y, "referral").find((o) => sameFirm(o.value, n.value));
      if (job && off && ["alumni", "mentor", "recruiter"].includes(y.role)) {
        out.push({
          kind: "referral", points: 3, a: [n.id], b: [job.id, off.id],
          why_a: `you asked for a referral at ${n.value}, and they work there and offered to refer people`,
          why_b: `they want a referral at ${n.value}, and you offered to refer people there`,
        });
      }
    }
  }
  return out;
}
const flip = (r: Reason): Reason => ({ ...r, a: r.b, b: r.a, why_a: r.why_b, why_b: r.why_a });

export function score(a: Profile, b: Profile): Score | null {
  const primary: Reason[] = [...served(a, b), ...served(b, a).map(flip)];
  for (const n of a.needs ?? []) {
    if (n.kind !== "prep") continue;
    const m = (b.needs ?? []).find((x) => x.kind === "prep" && sameText(x.value, n.value));
    if (m) {
      primary.push({
        kind: "prep", points: 3, a: [n.id], b: [m.id],
        why_a: `you both want a prep partner for ${n.value} interviews`,
        why_b: `you both want a prep partner for ${m.value} interviews`,
      });
    }
  }
  if (!primary.length) return null; // a shared school alone is no reason to meet
  const bonus: Reason[] = [];
  const school = factsOf(a, "school").map((s) => [s, factsOf(b, "school").find((t) => sameText(t.value, s.value))] as const)
    .find(([, t]) => t);
  if (school) {
    bonus.push({
      kind: "school", points: 1, a: [school[0].id], b: [school[1]!.id],
      why_a: `they went to ${school[0].value} too`, why_b: `they go to ${school[1]!.value} too`,
    });
  }
  // A shared target firm counts only when it is not already what the match is about.
  const cited = new Set(primary.flatMap((r) => [...r.a, ...r.b]));
  const subjects = new Set([...(a.needs ?? []), ...(b.needs ?? [])].filter((n) => cited.has(n.id)).map((n) => plain(firmName(n.value))));
  const firm = factsOf(a, "target_firm").map((s) => [s, factsOf(b, "target_firm").find((t) => sameFirm(t.value, s.value))] as const)
    .find(([s, t]) => t && !subjects.has(plain(firmName(s.value))));
  if (firm) {
    bonus.push({
      kind: "target_firm", points: 1, a: [firm[0].id], b: [firm[1]!.id],
      why_a: `you are both aiming for ${firm[0].value}`, why_b: `you are both aiming for ${firm[1]!.value}`,
    });
  }
  const reasons = [...primary, ...bonus];
  // No cite, no score: every reason names at least one real id from each side.
  const ids = (p: Profile) => new Set([...(p.facts ?? []), ...(p.needs ?? []), ...(p.offers ?? [])].map((x) => x.id));
  const ia = ids(a), ib = ids(b);
  if (!reasons.every((r) => r.a.length && r.b.length && r.a.every((x) => ia.has(x)) && r.b.every((x) => ib.has(x)))) return null;
  return { score: reasons.reduce((n, r) => n + r.points, 0), kind: primary[0].kind as NeedKind, reasons };
}

// ---------------------------------------------------------------- 3. the next proposal

export interface Proposal {
  b: Profile;
  kind: NeedKind;
  score: number;
  reasons: Reason[];
  why_a: string;
  why_b: string;
  cites: { a: string[]; b: string[] };
}
export type NoProposal = { none: "not_in_network" | "pending" | "weekly_cap" | "no_fit" };

const isPending = (i: IntroRow) => PENDING.includes(i.state);
const party = (i: IntroRow, u: string) => i.a_user === u || i.b_user === u;
const recent = (intros: IntroRow[], u: string, now: number) =>
  intros.filter((i) => party(i, u) && Date.parse(i.proposed_at) > now - WEEK_MS).length;
export const available = (p: Profile | null | undefined) => !!p && p.opted_in && !p.paused;
const sentence = (s: string) => {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".") : t;
};
const join = (parts: string[]) => sentence(parts.join("; "));

// One best person above the fit bar, or none. Never below the bar to hit a number. Both people's filters hold.
export function proposeNext(
  person: Profile,
  candidates: Profile[],
  history: { intros: IntroRow[]; blocks: BlockRow[] },
  now: number,
): Proposal | NoProposal {
  if (!available(person)) return { none: "not_in_network" };
  const intros = history.intros ?? [], blocks = history.blocks ?? [];
  if (intros.some((i) => party(i, person.user_id) && isPending(i))) return { none: "pending" };
  if (recent(intros, person.user_id, now) >= WEEKLY_CAP) return { none: "weekly_cap" };
  const f = person.filters ?? {};
  const bar = Math.max(FIT_BAR, Number(f.min_score) || 0);
  let best: (Proposal & { adjusted: number }) | null = null;
  for (const c of candidates) {
    if (!c || c.user_id === person.user_id || !available(c)) continue;
    if (VERIFY_ROLES.includes(c.role) && !c.verified) continue;
    if (blocks.some((x) => (x.blocker === person.user_id && x.blocked === c.user_id) || (x.blocker === c.user_id && x.blocked === person.user_id))) continue;
    if (intros.some((i) => party(i, person.user_id) && party(i, c.user_id))) continue; // a pair once, ever
    if (intros.some((i) => party(i, c.user_id) && isPending(i))) continue;
    if (recent(intros, c.user_id, now) >= WEEKLY_CAP) continue;
    if ((f.exclude_roles ?? []).includes(c.role) || (c.filters?.exclude_roles ?? []).includes(person.role)) continue;
    const s = score(person, c);
    if (!s || s.score < bar) continue;
    const adjusted = s.score + ((f.prefer_kinds ?? []).includes(s.kind) ? 1 : 0) - ((f.avoid_kinds ?? []).includes(s.kind) ? 2 : 0);
    if (adjusted < bar) continue;
    const better = !best || adjusted > best.adjusted || (adjusted === best.adjusted &&
      (s.score > best.score || (s.score === best.score && c.user_id < best.b.user_id)));
    if (better) {
      best = {
        b: c, kind: s.kind, score: s.score, adjusted, reasons: s.reasons,
        why_a: join(s.reasons.map((r) => r.why_a)), why_b: join(s.reasons.map((r) => r.why_b)),
        cites: { a: [...new Set(s.reasons.flatMap((r) => r.a))], b: [...new Set(s.reasons.flatMap((r) => r.b))] },
      };
    }
  }
  if (!best) return { none: "no_fit" };
  const { adjusted: _a, ...p } = best;
  return p;
}

// ---------------------------------------------------------------- 4 and 5. what each side is told

const ROLE_WORDS: Record<Role, string> = {
  student: "a student", candidate: "someone who is also job hunting", mentor: "a mentor", alumni: "an alum",
  recruiter: "a recruiter",
};
export const roleWords = (r: Role | null | undefined) => (r && ROLE_WORDS[r]) || "someone";
const nameOf = (p: Profile) => (p.facts ?? []).find((f) => f.kind === "name")?.value ?? null;

// Before both said yes: the other side's role kind and the why. No name, no contact, nothing else.
export function proposalText(v: { why: string; other_role: Role | null }): string {
  return `I found ${roleWords(v.other_role)} you might want to meet. Why: ${sentence(v.why)} ` +
    `Their name stays private until you both say yes, and nothing about you has been shared. ` +
    `Want the intro? Reply yes or no.`;
}

// After both said yes: who it is (their first name when they gave one), why, and an offer to pass times along.
export function introText(intro: { why_a: string; why_b: string }, a: Profile, b: Profile): { a: string; b: string } {
  const one = (why: string, other: Profile) => {
    const n = nameOf(other);
    const who = n ? `${n}, ${roleWords(other.role)}` : roleWords(other.role);
    const them = n ?? "them";
    return `You're connected with ${who}. You both said yes. Why: ${sentence(why)} ` +
      `Want help finding a time? Reply "times" and when you're free, like "times Tue 3pm or Wed noon", and I'll pass it to ${them}. ` +
      `Reply "block" if anything feels off.`;
  };
  return { a: one(intro.why_a, b), b: one(intro.why_b, a) };
}

// ---------------------------------------------------------------- 6. follow-through

export type FollowStep = "nudge" | "expire" | "checkin" | "checkin_nudge" | "no_reply";
export interface FollowUp { intro_id: string; step: FollowStep; to: ("a" | "b")[] }

// What the scheduled run does for each introduction now: a waiting proposal is nudged once after 72 hours, then expires
// 72 hours later; an introduction is checked on 72 hours after it was made, nudged once 72 hours after that, then
// recorded as no reply. Never more than one nudge at either stage.
export function checkins(intros: IntroRow[], now: number): FollowUp[] {
  const out: FollowUp[] = [];
  const t = (s?: string | null) => (s ? Date.parse(s) : NaN);
  for (const i of intros) {
    if (isPending(i)) {
      const waiting: ("a" | "b")[] = i.state === "a_yes" ? ["b"] : i.state === "b_yes" ? ["a"] : ["a", "b"];
      if (!i.nudge_at && now - t(i.proposed_at) >= FOLLOW_MS) out.push({ intro_id: i.id, step: "nudge", to: waiting });
      else if (i.nudge_at && now - t(i.nudge_at) >= FOLLOW_MS) {
        out.push({ intro_id: i.id, step: "expire", to: (["a", "b"] as const).filter((s) => !waiting.includes(s)) });
      }
    } else if (i.state === "introduced") {
      if (!i.checkin_at && now - t(i.intro_at) >= FOLLOW_MS) out.push({ intro_id: i.id, step: "checkin", to: ["a", "b"] });
      else if (i.checkin_at && !i.checkin_nudge_at && now - t(i.checkin_at) >= FOLLOW_MS) {
        out.push({ intro_id: i.id, step: "checkin_nudge", to: ["a", "b"] });
      } else if (i.checkin_nudge_at && now - t(i.checkin_nudge_at) >= FOLLOW_MS) out.push({ intro_id: i.id, step: "no_reply", to: [] });
    }
  }
  return out;
}
export function followText(step: FollowStep, otherName: string | null): string {
  const them = otherName ?? "them";
  switch (step) {
    case "nudge":
      return `Still thinking about the intro I suggested? Say "show my intro" to see it again. Nothing has been shared yet.`;
    case "expire":
      return `The other person didn't answer, so that intro is closed. Nothing about you was shared.`;
    case "checkin":
      return `Did you and ${them} get to talk? Reply "we met, it was useful", "we met, not useful" or "we didn't meet".`;
    case "checkin_nudge":
      return `Quick check: did you and ${them} talk? Reply "we met" or "we didn't meet". I won't ask again.`;
    case "no_reply":
      return "";
  }
}

// ---------------------------------------------------------------- 7. learning

export interface Feedback { met: boolean; useful: boolean | null }
// A useful intro of a kind is preferred next time; a met-but-not-useful one is avoided, and two not useful with the same
// kind of person stop that kind of person. Not meeting changes nothing (it says nothing about the match). The fit bar
// itself never moves down.
export function applyFeedback(filters: Filters, fb: Feedback & { kind: NeedKind; other_role: Role | null }): Filters {
  const f: Filters = JSON.parse(JSON.stringify(filters ?? {}));
  if (!fb.met || fb.useful === null || fb.useful === undefined) return f;
  const add = <T>(xs: T[] | undefined, x: T) => [...new Set([...(xs ?? []), x])];
  const drop = <T>(xs: T[] | undefined, x: T) => (xs ?? []).filter((y) => y !== x);
  if (fb.useful) {
    f.prefer_kinds = add(f.prefer_kinds, fb.kind);
    f.avoid_kinds = drop(f.avoid_kinds, fb.kind);
  } else {
    f.avoid_kinds = add(f.avoid_kinds, fb.kind);
    f.prefer_kinds = drop(f.prefer_kinds, fb.kind);
    if (fb.other_role) {
      const n = (f.not_useful_roles?.[fb.other_role] ?? 0) + 1;
      f.not_useful_roles = { ...(f.not_useful_roles ?? {}), [fb.other_role]: n };
      if (n >= 2) f.exclude_roles = add(f.exclude_roles, fb.other_role);
    }
  }
  if (f.min_score !== undefined && f.min_score < FIT_BAR) delete f.min_score;
  return f;
}

// ---------------------------------------------------------------- the texts

export type ConnectorAsk =
  | { kind: "connect"; need: NeedKind; value: string }
  | { kind: "by_name" }
  | { kind: "directory" }
  | { kind: "offer"; offer: OfferKind; value: string }
  | { kind: "employer"; value: string }
  | { kind: "join"; role: Role | null }
  | { kind: "leave" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "show" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "block"; report: boolean }
  | { kind: "feedback"; met: boolean; useful: boolean | null }
  | { kind: "times"; text: string };

const ROLE_SAID: Record<string, Role> = {
  student: "student", candidate: "candidate", "job seeker": "candidate", mentor: "mentor", alum: "alumni", alumni: "alumni",
  alumnus: "alumni", alumna: "alumni", recruiter: "recruiter",
};
const PEOPLE = "(?:someone|somebody|anyone|people|an? (?:alum|alumni|alumnus|alumna|mentor|recruiter|analyst|associate|employee|person|banker|consultant|engineer))";

export function parseConnectorAsk(text: string): ConnectorAsk | null {
  const whole = String(text ?? "").replace(/\s+/g, " ").trim();
  const raw = whole.replace(/[.!?]+$/, "").trim();
  const t = raw.toLowerCase().replace(/[’]/g, "'");
  if (!t || t.length > 300) return null;
  // A name the person typed keeps their capitals: the captured tail of the lowercased text, cut from the original.
  const said = (g: string) => raw.slice(t.length - g.length);
  const pre = "(?:can you |could you |please |pls |i want to |i'd like to |id like to )?";
  let m: RegExpMatchArray | null;
  if ((m = t.match(new RegExp(`^${pre}(?:connect|introduce) me (?:with|to) (?:someone|somebody|anyone) who (?:has )?interviewed (?:at|with) (.+)$`)))) {
    return { kind: "connect", need: "intel", value: firmName(said(m[1])) };
  }
  if ((m = t.match(new RegExp(`^${pre}(?:get me (?:a referral|referrals)|find (?:me )?someone (?:who can|to) refer me|connect me with someone who can refer me) (?:at|to) (.+)$`)))) {
    return { kind: "connect", need: "referral", value: firmName(said(m[1])) };
  }
  if ((m = t.match(new RegExp(`^${pre}(?:find|get|match) me (?:with )?an? (?:prep|study|practice|mock interview) (?:partner|group|buddy) (?:for|in) (.+?)(?: interviews?)?$`)))) {
    return { kind: "connect", need: "prep", value: clean(m[1], 120) };
  }
  if ((m = t.match(new RegExp(`^${pre}(?:connect|introduce) me (?:with|to) ${PEOPLE} (?:at|from) (.+)$`)))) {
    return { kind: "connect", need: "meet", value: firmName(said(m[1])) };
  }
  // "connect me with Maya Chen": nobody is looked up by name.
  if (new RegExp(`^${pre}(?:connect|introduce) me (?:with|to) .+$`).test(t)) return { kind: "by_name" };
  if (/^(?:show|list|search|browse|find|who are)(?: me)?(?: all)? (?:the )?(?:people|members|users|mentors|alumni|alums|recruiters|everyone)\b/.test(t) ||
    /^who(?: else)? is (?:on|in) (?:trainee|the network|introductions)/.test(t)) {
    return { kind: "directory" };
  }
  if ((m = t.match(/^i can (?:talk|chat|speak) (?:to|with) (?:students|people|candidates|job seekers|anyone) about (?:my work at |working at |my job at )?(.+)$/))) {
    return { kind: "offer", offer: "advice", value: firmName(said(m[1])) };
  }
  if ((m = t.match(/^i can (?:refer|give (?:a referral|referrals) to) (?:people|students|candidates|someone) (?:at|to) (.+)$/))) {
    return { kind: "offer", offer: "referral", value: firmName(said(m[1])) };
  }
  if ((m = t.match(/^i can share (?:my |what my )?(.+?) interviews?(?: experience| were like| was like| tips)?$/))) {
    return { kind: "offer", offer: "intel", value: firmName(m[1]) };
  }
  if ((m = t.match(/^i (?:work|worked|used to work) at ([^,;]+)$/)) && m[1].split(" ").length <= 5 && !/\b(?:and|but|so|because|need|want|looking)\b/.test(m[1])) {
    return { kind: "employer", value: firmName(said(m[1])) };
  }
  if ((m = t.match(/^(?:join|opt in to|opt into|sign me up for) (?:introductions|intros|the connector)(?: as an? (student|candidate|job seeker|mentor|alum|alumni|alumnus|alumna|recruiter))?$/))) {
    return { kind: "join", role: m[1] ? ROLE_SAID[m[1]] : null };
  }
  if (/^(?:leave|opt out of) (?:introductions|intros|the connector)$/.test(t)) return { kind: "leave" };
  if (/^pause (?:introductions|intros)$/.test(t)) return { kind: "pause" };
  if (/^(?:resume|unpause|restart) (?:introductions|intros)$/.test(t)) return { kind: "resume" };
  if (/^(?:show|see)(?: me)? my (?:intro|introduction|intros|introductions|match|suggestion)$/.test(t)) return { kind: "show" };
  if (/^(?:yes|yep|yeah|y|yes please|introduce us|yes introduce us)$/.test(t)) return { kind: "yes" };
  if (/^(?:no|nope|n|no thanks|not interested|pass)$/.test(t)) return { kind: "no" };
  if ((m = t.match(/^(block|report|block and report)(?: (?:them|him|her|this person))?$/))) return { kind: "block", report: m[1] !== "block" };
  if ((m = whole.match(/^times\b\s*[:,-]?\s*(.{2,300})$/i))) return { kind: "times", text: clean(m[1], 300) };
  if (/^(?:we )?(?:didn'?t|did not|never|haven'?t|have not) (?:meet|met|talk|talked|speak|spoke|get to talk)\b|^(?:no,? )?we didn'?t\b/.test(t)) {
    return { kind: "feedback", met: false, useful: null };
  }
  if (/^(?:we |yes,? we |yeah,? we )?(?:met|talked|spoke|had (?:a|the) (?:call|chat))\b/.test(t)) {
    const useful = /\b(?:not|wasn'?t|was not|isn'?t) (?:that |very |really )?(?:useful|helpful)\b|\buseless\b|\bwaste\b/.test(t)
      ? false
      : /\b(?:useful|helpful|great|good|worth it)\b/.test(t) ? true : null;
    return { kind: "feedback", met: true, useful };
  }
  return null;
}

export interface Sources { stated: StatedFact[]; career: CareerData | null }
export interface ConnectorStore {
  open(): Promise<boolean>; // connector_open(): 500 opted-in, unpaused profiles
  profile(userId: string): Promise<Profile | null>; // the person's own
  sources(userId: string): Promise<Sources>;
  saveProfile(userId: string, p: { role: Role; needs: Item[]; offers: Item[]; facts: Item[]; filters?: Filters }): Promise<Profile>;
  optOut(userId: string): Promise<void>;
  pause(userId: string, paused: boolean): Promise<void>;
  candidates(userId: string): Promise<Profile[]>; // server-side only, never shown to anyone
  // Every introduction the person was ever on, everyone's still waiting or from the last 7 days (the pending and weekly
  // rules), and every block the person is on either side of.
  history(userId: string, now: number): Promise<{ intros: IntroRow[]; blocks: BlockRow[] }>;
  propose(a: string, b: string, kind: NeedKind, whyA: string, whyB: string, cites: { a: string[]; b: string[] }): Promise<string>;
  mine(userId: string): Promise<MyIntro[]>; // redacted, newest first
  answer(userId: string, introId: string, yes: boolean): Promise<MyIntro>;
  parties(introId: string): Promise<{ intro: { why_a: string; why_b: string }; a: Profile; b: Profile }>; // after both yes only
  introduced(introId: string): Promise<void>;
  block(userId: string, introId: string, report: boolean): Promise<void>;
  feedback(userId: string, introId: string, fb: Feedback, filters: Filters): Promise<void>;
  // Puts a text into the person's thread as Upmore's last word. False when it cannot be the last word now (quiet hours,
  // mid-conversation, STOP): the person sees a proposal again with "show my intro".
  notify(userId: string, text: string, intent: string): Promise<boolean>;
  lastAssistantIntent(threadId: string): Promise<string | null>;
}
export interface ConnectorReply { reply: string; status: string; intent?: string; intro_id?: string }

export const connectorEnabled = (flag: string | undefined | null) => String(flag ?? "").trim().toLowerCase() === "on";
const NOT_OPEN = "Introductions to other people aren't open yet. Nothing about you has been shared.";
const JOIN_FIRST =
  `Introductions are opt-in. If you join, I keep a private match profile from what you tell me and the school, target firms and roles you've given me. Nobody can browse or search it. Reply "join introductions as a student" (or candidate, mentor, alum, recruiter).`;
const NO_NAMES =
  `I don't look people up by name, and there's no list of members to browse. Tell me a firm or a role, like "connect me with someone at JPMorgan", and I'll suggest one person when there's a real reason to meet.`;
const STARTS_LATER = "Introductions start once enough people have joined. Nothing is shared before then.";

function profileLine(p: { facts: Item[]; needs: Item[]; offers: Item[] }): string {
  const by = (k: string) => p.facts.filter((f) => f.kind === k).map((f) => f.value);
  const parts = [
    by("school").length ? `school ${by("school").join(", ")}` : "",
    by("employer").length ? `work at ${by("employer").join(", ")}` : "",
    by("target_firm").length ? `target firms ${by("target_firm").join(", ")}` : "",
    by("target_role").length ? `target roles ${by("target_role").join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "nothing yet";
}
const NEED_WORDS: Record<NeedKind, (v: string) => string> = {
  meet: (v) => `you want to meet someone at ${v}`,
  intel: (v) => `you want to hear how ${v} interviews go`,
  referral: (v) => `you want a referral at ${v}`,
  prep: (v) => `you want a prep partner for ${v} interviews`,
};
const OFFER_WORDS: Record<OfferKind, (v: string) => string> = {
  advice: (v) => `you can talk with people about ${v}`,
  intel: (v) => `you can share what your ${v} interviews were like`,
  referral: (v) => `you can refer people at ${v}`,
};

type TurnInput = {
  message: string;
  userId: string;
  threadId: string;
  now: number;
  store: ConnectorStore;
  flag?: string | null; // CONNECTOR_ENABLED
};
// One turn, before any brain. Returns null when the text is not for the Connector, so the turn goes on as before. Every
// reply carries an intent starting "connector" for the handler to store on the message (the last-word rule reads it).
export async function connectorTurn(o: TurnInput): Promise<ConnectorReply | null> {
  const r = await turn(o);
  return r && { ...r, intent: r.intent ?? CONNECTOR_INTENT };
}
async function turn(o: TurnInput): Promise<ConnectorReply | null> {
  const ask = parseConnectorAsk(o.message);
  if (!ask) return null;
  const { store, userId: u } = o;
  // Answers count only while the Connector's own question is the thread's last word. "I work at X" is the Connector's
  // only when it just asked for it; anywhere else it belongs to the rest of Trainee.
  if (ask.kind === "yes" || ask.kind === "no" || ask.kind === "feedback" || ask.kind === "times" || ask.kind === "employer") {
    const last = await store.lastAssistantIntent(o.threadId);
    const wants = ask.kind === "feedback" ? [CHECKIN_INTENT] : ask.kind === "times" ? [INTRO_INTENT, TIMES_INTENT] : ask.kind === "employer" ? [CONNECTOR_INTENT] : [PROPOSAL_INTENT];
    if (!last || !wants.includes(last)) return null;
  }
  if (!connectorEnabled(o.flag)) {
    if (ask.kind === "block" || ask.kind === "offer" || ask.kind === "employer") return null;
    return { reply: NOT_OPEN, status: "closed" };
  }
  if (ask.kind === "by_name" || ask.kind === "directory") return { reply: NO_NAMES, status: "no_directory" };

  if (ask.kind === "block") {
    const latest = (await store.mine(u))[0];
    if (!latest) return null;
    await store.block(u, latest.id, ask.report);
    return ask.report
      ? { reply: "Reported. They won't see you in introductions again, and a person on our team will review it. Nothing is said to them.", status: "reported" }
      : { reply: "Blocked. You two won't be suggested to each other again, and nothing is said to them.", status: "blocked" };
  }

  const mine = () => store.mine(u);
  const waitingOnMe = (list: MyIntro[]) => list.find((i) => PENDING.includes(i.state) && i.my_answer !== "yes") ?? null;

  if (ask.kind === "yes" || ask.kind === "no") {
    const p = waitingOnMe(await mine());
    if (!p) return { reply: "That intro is closed. Nothing was shared.", status: "closed_intro" };
    let v: MyIntro;
    try {
      v = await store.answer(u, p.id, ask.kind === "yes");
    } catch (e) {
      if (/intro_closed|intro_answered/.test(String((e as Error)?.message ?? e))) {
        return { reply: "That intro is closed. Nothing was shared.", status: "closed_intro" };
      }
      throw e;
    }
    if (v.state === "both_yes") {
      const pt = await store.parties(v.id);
      const texts = introText(pt.intro, pt.a, pt.b);
      await store.introduced(v.id);
      const other = v.side === "a" ? pt.b : pt.a;
      await store.notify(other.user_id, v.side === "a" ? texts.b : texts.a, INTRO_INTENT);
      return { reply: v.side === "a" ? texts.a : texts.b, status: "introduced", intent: INTRO_INTENT };
    }
    if (v.state === "expired") return { reply: "That suggestion expired, so nothing was shared.", status: "expired" };
    if (v.state === "declined") {
      return ask.kind === "no"
        ? { reply: "Okay, no intro. Nothing about you was shared.", status: "declined" }
        : { reply: "That intro is closed. Nothing was shared.", status: "closed_intro" };
    }
    return { reply: "Got it. I'll tell you if they say yes too. Nothing about you has been shared yet.", status: "waiting" };
  }

  if (ask.kind === "show") {
    const list = await mine();
    const p = waitingOnMe(list);
    if (p) return { reply: proposalText(p), status: "shown", intent: PROPOSAL_INTENT };
    if (list.some((i) => PENDING.includes(i.state))) {
      return { reply: "You said yes. I'm waiting on them, and nothing has been shared yet.", status: "waiting" };
    }
    return { reply: "No intro is waiting right now.", status: "none" };
  }

  if (ask.kind === "feedback") {
    const it = (await mine()).find((i) => INTRODUCED.includes(i.state));
    if (!it) return null;
    const me = await store.profile(u);
    const fb = { met: ask.met, useful: ask.useful };
    const filters = applyFeedback(me?.filters ?? {}, { ...fb, kind: it.kind, other_role: it.other_role });
    await store.feedback(u, it.id, fb, filters);
    const reply = !ask.met
      ? "Thanks, noted. That doesn't count against anyone."
      : ask.useful === true
      ? "Glad it helped. I'll look for more intros like that one."
      : ask.useful === false
      ? "Thanks for saying so. I'll suggest different kinds of intros."
      : "Thanks, noted.";
    return { reply, status: "feedback" };
  }

  if (ask.kind === "times") {
    const it = (await mine()).find((i) => INTRODUCED.includes(i.state) && i.other_user);
    if (!it || !it.other_user) return null;
    const h = await store.history(u, o.now);
    if (h.blocks.some((b) => (b.blocker === u && b.blocked === it.other_user) || (b.blocker === it.other_user && b.blocked === u))) {
      return { reply: "I can't pass that along.", status: "blocked" };
    }
    const pt = await store.parties(it.id);
    const me = it.side === "a" ? pt.a : pt.b, other = it.side === "a" ? pt.b : pt.a;
    const sent = await store.notify(
      other.user_id,
      `${nameOf(me) ?? "Your intro"} suggested times: "${ask.text}". Reply "times" and what works for you, and I'll pass it back.`,
      TIMES_INTENT,
    );
    return sent
      ? { reply: `Sent to ${nameOf(other) ?? "them"}. I'll pass back what they say.`, status: "times_sent", intent: TIMES_INTENT }
      : { reply: "I couldn't pass that along right now. Try again in a bit.", status: "times_held" };
  }

  // Joining, leaving, pausing, and what the person needs or offers.
  const open = await store.open();
  const prof = await store.profile(u);
  if (ask.kind === "join") {
    if (!ask.role) {
      return { reply: `As what? Reply "join introductions as a student" (or candidate, mentor, alum, recruiter).`, status: "ask_role" };
    }
    const src = await store.sources(u);
    const built = profileFrom(src.stated, src.career);
    const facts = merge(prof?.opted_in ? prof.facts : [], built.facts);
    const saved = await store.saveProfile(u, {
      role: ask.role, needs: prof?.opted_in ? prof.needs : [], offers: prof?.opted_in ? prof.offers : [], facts,
      filters: prof?.filters ?? {},
    });
    const verify = VERIFY_ROLES.includes(ask.role)
      ? " Mentors and recruiters are checked by our team before anyone is matched with them."
      : "";
    return {
      reply: `You're in as ${roleWords(ask.role)}. Your match profile has ${profileLine(saved)}. Only you can see it, and nobody can browse or search it.${verify}${open ? "" : " " + STARTS_LATER} ` +
        `Tell me what you're looking for, like "connect me with someone at JPMorgan", or what you can offer, like "I can talk to students about Goldman Sachs".`,
      status: "joined",
    };
  }
  if (ask.kind === "leave") {
    if (!prof?.opted_in) return { reply: "You're not in introductions. Nothing is kept for them.", status: "not_in" };
    await store.optOut(u);
    return { reply: "You've left introductions. Your match profile is cleared, and any intro waiting for an answer is closed.", status: "left" };
  }
  if (!prof?.opted_in) return ask.kind === "offer" || ask.kind === "employer" ? null : { reply: JOIN_FIRST, status: "join_first" };
  if (ask.kind === "pause" || ask.kind === "resume") {
    await store.pause(u, ask.kind === "pause");
    return ask.kind === "pause"
      ? { reply: `Introductions are paused. Nobody is suggested to you or you to them until you say "resume introductions".`, status: "paused" }
      : { reply: "Introductions are back on.", status: "resumed" };
  }
  if (ask.kind === "employer" || ask.kind === "offer") {
    const facts = ask.kind === "employer" ? withItem(prof.facts, factItem("employer", ask.value, o.message)) : prof.facts;
    const offers = ask.kind === "offer" ? withItem(prof.offers, offerItem(ask.offer, ask.value, o.message)) : prof.offers;
    await store.saveProfile(u, { role: prof.role, needs: prof.needs, offers, facts, filters: prof.filters });
    if (ask.kind === "employer") return { reply: `Saved: you work at ${ask.value} or did before. Only you can see your match profile.`, status: "saved_fact" };
    const needsJob = ask.offer !== "intel" && !facts.some((f) => f.kind === "employer" && sameFirm(f.value, ask.value));
    return {
      reply: `Saved: ${OFFER_WORDS[ask.offer](ask.value)}.` +
        (needsJob ? ` To be matched on it, tell me "I work at ${ask.value}" if you do or did.` : "") +
        (open ? "" : " " + STARTS_LATER),
      status: "saved_offer",
    };
  }

  // "connect me with someone at JPM": saved as a need in their words, then one proposal if one fits.
  if (prof.paused) return { reply: `Introductions are paused for you. Say "resume introductions" first.`, status: "paused" };
  const need = needItem(ask.need, ask.value, o.message);
  const me = await store.saveProfile(u, { role: prof.role, needs: withItem(prof.needs, need), offers: prof.offers, facts: prof.facts, filters: prof.filters });
  const saved = `Saved: ${NEED_WORDS[ask.need](need.value)}.`;
  if (!open) return { reply: `${saved} ${STARTS_LATER}`, status: "saved_need" };
  const list = await mine();
  if (waitingOnMe(list)) {
    return { reply: `${saved} You have an intro waiting for your answer first. Say "show my intro" to see it.`, status: "pending" };
  }
  const cands = await store.candidates(u);
  const hist = await store.history(u, o.now);
  const p = proposeNext(me, cands, hist, o.now);
  if ("none" in p) {
    const why = p.none === "weekly_cap"
      ? "You've had 3 suggestions this week, the most I send. More next week."
      : p.none === "pending"
      ? "You have an intro waiting on the other person first."
      : "Nobody fits well yet. I only suggest someone when there's a real reason to meet.";
    return { reply: `${saved} ${why}`, status: p.none };
  }
  let id: string;
  try {
    id = await store.propose(u, p.b.user_id, p.kind, p.why_a, p.why_b, p.cites);
  } catch (e) {
    if (/connector_closed|not_opted_in|unverified|blocked|repeat|pending|weekly_cap|missing_cites/.test(String((e as Error)?.message ?? e))) {
      return { reply: `${saved} Nobody fits well yet. I only suggest someone when there's a real reason to meet.`, status: "refused" };
    }
    throw e;
  }
  await store.notify(p.b.user_id, proposalText({ why: p.why_b, other_role: me.role }), PROPOSAL_INTENT);
  return { reply: proposalText({ why: p.why_a, other_role: p.b.role }), status: "proposed", intent: PROPOSAL_INTENT, intro_id: id };
}

// ---------------------------------------------------------------- stores

const viewOf = (i: IntroRow & { why_a: string; why_b: string }, u: string, roleOf: (x: string) => Role | null, blocks: BlockRow[]): MyIntro => {
  const side = i.a_user === u ? "a" : "b";
  const other = side === "a" ? i.b_user : i.a_user;
  const hidden = blocks.some((b) => b.blocker === other && b.blocked === u);
  return {
    id: i.id, kind: i.kind, state: i.state, side, why: side === "a" ? i.why_a : i.why_b, other_role: roleOf(other),
    other_user: AFTER_BOTH_YES.includes(i.state) && !hidden ? other : null,
    my_answer: AFTER_BOTH_YES.includes(i.state) || i.state === `${side}_yes` ? "yes" : null,
    proposed_at: i.proposed_at, intro_at: i.intro_at ?? null,
    my_feedback: (i.feedback as any)?.[side] ?? null,
  };
};

// An in-memory store with the database's own rules (the migration is the authority; tests/db/career_connector.test.sql
// proves it there). For the text simulator and tests: every refusal of connector_propose_for is enforced here too.
export function memoryConnectorStore(o: {
  profiles?: Profile[];
  sources?: Record<string, Sources>;
  network?: number; // opted-in profiles outside this store, counted toward the 500
  now?: () => number;
} = {}) {
  const now = o.now ?? (() => Date.now());
  const profiles = new Map<string, Profile>((o.profiles ?? []).map((p) => [p.user_id, structuredClone(p)]));
  const intros: (IntroRow & { why_a: string; why_b: string; cites: unknown })[] = [];
  const blocks: (BlockRow & { reported: boolean; reviewed_at: string | null })[] = [];
  const threads: Record<string, { role: string; text: string; intent: string | null }[]> = {};
  const outbox: { to: string; text: string; intent: string }[] = [];
  const busy = new Set<string>();
  let seq = 0;
  const iso = () => new Date(now()).toISOString();
  const roleOf = (x: string) => profiles.get(x)?.role ?? null;
  const blocked = (x: string, y: string) => blocks.some((b) => (b.blocker === x && b.blocked === y) || (b.blocker === y && b.blocked === x));
  const find = (u: string, id: string) => {
    const i = intros.find((x) => x.id === id && party(x, u));
    if (!i) throw new Error("invalid intro");
    return i;
  };
  const store: ConnectorStore = {
    async open() {
      return [...profiles.values()].filter(available).length + (o.network ?? 0) >= MIN_NETWORK;
    },
    async profile(u) {
      return profiles.has(u) ? structuredClone(profiles.get(u)!) : null;
    },
    async sources(u) {
      return structuredClone(o.sources?.[u] ?? { stated: [], career: null });
    },
    async saveProfile(u, p) {
      const all = [...p.needs, ...p.offers, ...p.facts];
      if (!ROLES.includes(p.role) || all.some((x) => !x.id || !x.source || !x.value) || new Set(all.map((x) => x.id)).size !== all.length) {
        throw new Error("invalid connector profile");
      }
      const old = profiles.get(u);
      const next: Profile = {
        user_id: u, role: p.role, verified: old && old.role === p.role ? old.verified : false, opted_in: true, paused: false,
        needs: structuredClone(p.needs), offers: structuredClone(p.offers), facts: structuredClone(p.facts),
        filters: structuredClone(p.filters ?? old?.filters ?? {}),
      };
      profiles.set(u, next);
      return structuredClone(next);
    },
    async optOut(u) {
      const p = profiles.get(u);
      if (p) Object.assign(p, { opted_in: false, needs: [], offers: [], facts: [] });
      for (const i of intros) if (party(i, u) && isPending(i)) Object.assign(i, { state: "expired", decided_at: iso() });
    },
    async pause(u, paused) {
      const p = profiles.get(u);
      if (!p) throw new Error("not_in_network");
      p.paused = paused;
      if (paused) for (const i of intros) if (party(i, u) && isPending(i)) Object.assign(i, { state: "expired", decided_at: iso() });
    },
    async candidates(u) {
      return [...profiles.values()].filter((p) => p.user_id !== u && available(p)).map((p) => structuredClone(p));
    },
    async history(u, t) {
      return {
        intros: structuredClone(intros.filter((i) => party(i, u) || isPending(i) || Date.parse(i.proposed_at) > t - WEEK_MS)),
        blocks: structuredClone(blocks.filter((b) => b.blocker === u || b.blocked === u)),
      };
    },
    async propose(a, b, kind, whyA, whyB, cites) {
      const t = now();
      if (!a || !b || a === b || !whyA?.trim() || !whyB?.trim()) throw new Error("invalid proposal");
      if (!(await store.open())) throw new Error("connector_closed");
      const pa = profiles.get(a), pb = profiles.get(b);
      if (!available(pa) || !available(pb)) throw new Error("not_opted_in");
      if ([pa!, pb!].some((p) => VERIFY_ROLES.includes(p.role) && !p.verified)) throw new Error("unverified");
      if (blocked(a, b)) throw new Error("blocked");
      if (intros.some((i) => party(i, a) && party(i, b))) throw new Error("repeat");
      if (intros.some((i) => (party(i, a) || party(i, b)) && isPending(i))) throw new Error("pending");
      if (recent(intros, a, t) >= WEEKLY_CAP || recent(intros, b, t) >= WEEKLY_CAP) throw new Error("weekly_cap");
      const holds = (p: Profile, ids: string[]) => {
        const have = new Set([...p.facts, ...p.needs, ...p.offers].map((x) => x.id));
        return Array.isArray(ids) && ids.length > 0 && ids.every((x) => have.has(x));
      };
      if (!holds(pa!, cites?.a) || !holds(pb!, cites?.b)) throw new Error("missing_cites");
      const id = `I${++seq}`;
      intros.push({ id, a_user: a, b_user: b, kind, why_a: whyA.trim(), why_b: whyB.trim(), cites, state: "proposed", proposed_at: new Date(t).toISOString(), feedback: {} });
      return id;
    },
    async mine(u) {
      return intros.filter((i) => party(i, u)).sort((x, y) => y.proposed_at.localeCompare(x.proposed_at) || y.id.localeCompare(x.id))
        .map((i) => viewOf(i, u, roleOf, blocks));
    },
    async answer(u, id, yes) {
      const i = find(u, id);
      if (["declined", "expired"].includes(i.state)) throw new Error("intro_closed");
      if (!isPending(i)) throw new Error("intro_answered");
      const side = i.a_user === u ? "a" : "b";
      if (Date.parse(i.proposed_at) < now() - WEEK_MS) Object.assign(i, { state: "expired", decided_at: iso() });
      else if (!yes || blocked(i.a_user, i.b_user)) Object.assign(i, { state: "declined", decided_at: iso() });
      else if ((side === "a" && i.state === "b_yes") || (side === "b" && i.state === "a_yes")) Object.assign(i, { state: "both_yes", decided_at: iso() });
      else if (i.state === "proposed") i.state = `${side}_yes`;
      return viewOf(i, u, roleOf, blocks);
    },
    async parties(id) {
      const i = intros.find((x) => x.id === id);
      if (!i || !AFTER_BOTH_YES.includes(i.state)) throw new Error("not_both_yes");
      return { intro: { why_a: i.why_a, why_b: i.why_b }, a: structuredClone(profiles.get(i.a_user)!), b: structuredClone(profiles.get(i.b_user)!) };
    },
    async introduced(id) {
      const i = intros.find((x) => x.id === id);
      if (!i || i.state !== "both_yes" || blocked(i.a_user, i.b_user)) throw new Error("followup_refused");
      Object.assign(i, { state: "introduced", intro_at: iso() });
    },
    async block(u, id, report) {
      const i = find(u, id);
      const other = i.a_user === u ? i.b_user : i.a_user;
      const old = blocks.find((b) => b.blocker === u && b.blocked === other);
      if (old) old.reported = old.reported || report;
      else blocks.push({ blocker: u, blocked: other, reported: report, reviewed_at: null });
      if (isPending(i)) Object.assign(i, { state: "declined", decided_at: iso() });
    },
    async feedback(u, id, fb, filters) {
      const i = find(u, id);
      if (!INTRODUCED.includes(i.state)) throw new Error("not_introduced");
      const side = i.a_user === u ? "a" : "b";
      i.feedback = { ...(i.feedback ?? {}), [side]: { ...fb, at: iso() } };
      i.state = fb.met || i.state === "met" ? "met" : "no_meeting";
      profiles.get(u)!.filters = structuredClone(filters);
    },
    async notify(u, text, intent) {
      if (busy.has(u)) return false;
      (threads[u] ??= []).push({ role: "assistant", text, intent });
      outbox.push({ to: u, text, intent });
      return true;
    },
    async lastAssistantIntent(threadId) {
      const a = (threads[threadId] ?? []).filter((m) => m.role === "assistant");
      return a.length ? a[a.length - 1].intent : null;
    },
  };
  return {
    store,
    threads,
    outbox,
    busy,
    // For tests and the simulator: the raw rows, which no person ever reads.
    rows: () => structuredClone({ intros, blocks, profiles: [...profiles.values()] }),
    verify(u: string) {
      profiles.get(u)!.verified = true;
    },
    followup(id: string, step: FollowStep) {
      const i = intros.find((x) => x.id === id)!;
      const t = iso();
      if (step === "nudge") i.nudge_at = t;
      if (step === "expire") Object.assign(i, { state: "expired", decided_at: t });
      if (step === "checkin") i.checkin_at = t;
      if (step === "checkin_nudge") i.checkin_nudge_at = t;
      if (step === "no_reply") i.state = "no_reply";
    },
  };
}

// The store over the edge function's service client. Every write names the person (the _as functions); reads of other
// people's profiles happen here only, server-side, to match, and are never returned to anyone. `deliver` is the texting
// path's own (thread + outbox, quiet hours, STOP, mid-conversation), supplied by the wiring; `career` reads the master
// profile Trainee already holds, when there is one.
export function supabaseConnectorStore(admin: any, o: {
  deliver: (userId: string, text: string, intent: string) => Promise<boolean>;
  career?: (userId: string) => Promise<CareerData | null>;
}): ConnectorStore {
  const must = (r: any, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data;
  };
  const COLS = "user_id,role,verified,opted_in,paused,needs,offers,facts,filters";
  return {
    async open() {
      return must(await admin.rpc("connector_open"), "check the network") === true;
    },
    async profile(u) {
      return must(await admin.from("connector_profiles").select(COLS).eq("user_id", u).maybeSingle(), "read the match profile") ?? null;
    },
    async sources(u) {
      const acct = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", "career:account").maybeSingle(), "read the account");
      const stated = acct?.value?.stated_facts?.facts;
      return { stated: Array.isArray(stated) ? stated : [], career: o.career ? await o.career(u) : null };
    },
    async saveProfile(u, p) {
      return must(await admin.rpc("connector_opt_in_as", {
        p_user: u, p_role: p.role, p_needs: p.needs, p_offers: p.offers, p_facts: p.facts, p_filters: p.filters ?? null,
      }), "save the match profile");
    },
    async optOut(u) {
      must(await admin.rpc("connector_opt_out_as", { p_user: u }), "leave introductions");
    },
    async pause(u, paused) {
      must(await admin.rpc("connector_pause_as", { p_user: u, p_paused: paused }), "pause introductions");
    },
    async candidates(u) {
      return must(await admin.from("connector_profiles").select(COLS).eq("opted_in", true).eq("paused", false).neq("user_id", u).limit(5000), "read candidates") ?? [];
    },
    async history(u, now) {
      const cols = "id,a_user,b_user,kind,state,proposed_at,decided_at,intro_at,nudge_at,checkin_at,checkin_nudge_at";
      const since = new Date(now - WEEK_MS).toISOString();
      const own = must(await admin.from("connector_intros").select(cols).or(`a_user.eq.${u},b_user.eq.${u}`).limit(5000), "read introductions") ?? [];
      const live = must(await admin.from("connector_intros").select(cols).or(`state.in.(${PENDING.join(",")}),proposed_at.gt.${since}`).limit(50000), "read recent introductions") ?? [];
      const blocks = must(await admin.from("connector_blocks").select("blocker,blocked").or(`blocker.eq.${u},blocked.eq.${u}`).limit(5000), "read blocks") ?? [];
      const seen = new Set<string>();
      return { intros: [...own, ...live].filter((i: IntroRow) => !seen.has(i.id) && seen.add(i.id)), blocks };
    },
    async propose(a, b, kind, whyA, whyB, cites) {
      return must(await admin.rpc("connector_propose_for", { p_a: a, p_b: b, p_kind: kind, p_why_a: whyA, p_why_b: whyB, p_cites: cites }), "propose")?.id;
    },
    async mine(u) {
      return must(await admin.rpc("connector_my_proposals_as", { p_user: u, p_limit: 20 }), "read introductions") ?? [];
    },
    async answer(u, id, yes) {
      return must(await admin.rpc("connector_answer_as", { p_user: u, p_intro: id, p_yes: yes }), "answer the intro");
    },
    async parties(id) {
      const i = must(await admin.from("connector_intros").select("a_user,b_user,state,why_a,why_b").eq("id", id).maybeSingle(), "read the intro");
      if (!i || !AFTER_BOTH_YES.includes(i.state)) throw new Error("not_both_yes");
      const ps = must(await admin.from("connector_profiles").select(COLS).in("user_id", [i.a_user, i.b_user]), "read both profiles") ?? [];
      const a = ps.find((p: Profile) => p.user_id === i.a_user), b = ps.find((p: Profile) => p.user_id === i.b_user);
      if (!a || !b) throw new Error("not_both_yes");
      return { intro: { why_a: i.why_a, why_b: i.why_b }, a, b };
    },
    async introduced(id) {
      must(await admin.rpc("connector_followup_for", { p_intro: id, p_step: "introduced" }), "record the intro");
    },
    async block(u, id, report) {
      must(await admin.rpc("connector_block_as", { p_user: u, p_intro: id, p_reason: null, p_report: report }), "block");
    },
    async feedback(u, id, fb, filters) {
      must(await admin.rpc("connector_feedback_as", { p_user: u, p_intro: id, p_feedback: fb, p_filters: filters }), "record feedback");
    },
    notify: (u, text, intent) => o.deliver(u, text, intent),
    async lastAssistantIntent(threadId) {
      const rows = must(
        await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1),
        "read the last reply",
      );
      return rows?.[0]?.meta?.intent ?? null;
    },
  };
}
