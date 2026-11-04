// The Person Context Pack: one structured, labeled picture of this person, built by code every turn and put in the agent's
// system prompt. Each field says where it came from:
//   confirmed  a fact the person confirmed (usable anywhere, including in applications);
//   said       their own words in this chat or a fact still waiting for their yes (fine to advise from, never to submit);
//   unknown    nothing says; the model may ask about at most one unknown, and only if the answer changes its advice.
// Nothing here is inferred by a model. Signals (signals.ts) only point retrieval at a method; they are not facts.
import { confirmedRow, factRows } from "../memory.ts";
import type { Standing } from "../memory.ts";
import { personalSourceGuard } from "../../personal_fact_source.ts";
import { isTopic, LEVELS, levelOfFact, signalsOf, switchIntent, wantsSwitch, type Level } from "./signals.ts";

export type Status = "confirmed" | "said" | "unknown";
export interface Known<T> { value: T | null; status: Status; from?: string }
export interface ContextPack {
  stage: Known<string>;
  overlays: { tag: string; status: Status }[];
  education: Known<string[]>;
  major: Known<string>;
  experience: Known<string[]>;
  skills: Known<string[]>;
  projects: Known<string[]>;
  goals: Known<string[]>;
  places: Known<string[]>;
  constraints: Known<string[]>;
  authorization: Known<string>;
  deadlines: Known<string[]>;
  confidence: Known<string>;
  said_in_chat: string[];
  alerts: string | null;
  in_flight: string | null;
  unknown: string[];
  // signal -> weight (6 this message, 5 confirmed fact, 4 earlier in the chat or a draft fact); see retrieve.ts
  weights: Record<string, number>;
}
export interface PackInput {
  profile?: any;
  standing?: Standing[];
  alertsLine?: string | null;
  situation?: { tasks?: unknown[]; next?: { who: string; what: string }[] } | null;
  history?: { role: string; content: string }[];
  message: string;
}

const W_MESSAGE = 6, W_CONFIRMED = 5, W_CHAT = 4;
const MAX_ITEMS = 6, MAX_ITEM_CHARS = 200, HISTORY_USER_TURNS = 8;
const clip = (s: string, n = MAX_ITEM_CHARS) => String(s).replace(/\s+/g, " ").trim().slice(0, n);
const PROJECT = /\b(built|build|project|created|developed|launched|designed|wrote|published|app|website|tool|thesis|paper|prototype|github)\b/i;
const AUTH = /\b(visa|f-?1|opt|cpt|h-?1b|citizen|green card|work (authorization|permit)|sponsor\w*|permanent resident|ead)\b/i;
const DEADLINE = /\b(by|before|until|deadline|due|graduat\w+|starts?|ends?|expires?|leave|leaving)\b[^.]{0,60}\b(january|february|march|april|may|june|july|august|september|october|november|december|fall|spring|summer|winter|next (week|month|year|term|semester)|\d{1,2}\/\d{1,2}|20\d\d)\b/i;
const MAJOR = [/\bmajor(?:ing)? in ((?:[a-z]+ ?){1,3})/i, /\b([a-z]+(?: [a-z]+)?) major\b/i, /\bstudying ((?:[a-z]+ ?){1,3})/i, /\bdegree in ((?:[a-z]+ ?){1,3})/i];
const NOT_MAJOR = new Set(["a", "an", "the", "my", "i", "im", "am", "freshman", "sophomore", "junior", "senior", "first", "second", "year", "and", "or", "is", "was", "no", "not", "undeclared", "double", "minor", "at", "for", "to", "of", "in", "with", "but", "so", "now", "just", "currently", "still", "been", "being"]);
const majorOf = (t: string): string | null => {
  for (const rx of MAJOR) {
    const m = rx.exec(t.replace(/[\u2019]/g, "'").replace(/\b[a-z]*'[a-z]+\b/gi, " "));
    if (m) {
      const words = m[1].toLowerCase().split(/\s+/).filter(Boolean);
      while (words.length && NOT_MAJOR.has(words[0])) words.shift();
      while (words.length && NOT_MAJOR.has(words[words.length - 1])) words.pop();
      if (words.length) return words.join(" ");
    }
  }
  return null;
};

function pick<T>(confirmed: T[], said: T[]): { items: T[]; status: Status } {
  if (confirmed.length) return { items: confirmed, status: "confirmed" };
  if (said.length) return { items: said, status: "said" };
  return { items: [], status: "unknown" };
}
function list(confirmed: string[], said: string[], from?: string): Known<string[]> {
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => clip(x)).filter(Boolean))].slice(0, MAX_ITEMS);
  const p = pick(uniq(confirmed), uniq(said));
  return p.items.length ? { value: p.items, status: p.status, from } : { value: null, status: "unknown" };
}
const one = (confirmed: string | null, said: string | null, from?: string): Known<string> =>
  confirmed ? { value: confirmed, status: "confirmed", from } : said ? { value: said, status: "said", from } : { value: null, status: "unknown" };

export function buildContextPack(o: PackInput): ContextPack {
  const profile = o.profile ?? null;
  const denied = personalSourceGuard([profile]);
  const facts = factRows(profile);
  const confirmedF = facts.filter(confirmedRow), draftF = facts.filter((f: any) => !confirmedRow(f));
  const texts = (fs: any[], kinds?: string[]) => fs.filter((f) => !kinds || kinds.includes(f.kind)).map((f) => String(f.text));
  const pref = !profile || denied(profile) || denied(profile.preferences) ? {} : profile.preferences ?? {};
  const basics = !profile || denied(profile) || denied(profile.basics) ? {} : profile.basics ?? {};
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

  // What the person said in this chat: the current message first, then their earlier turns (newest first).
  const userTurns = (o.history ?? []).filter((m) => m && m.role === "user" && typeof m.content === "string").map((m) => m.content).slice(-HISTORY_USER_TURNS).reverse();
  const chat = [o.message, ...userTurns];

  // Signals with their weights. Message > confirmed fact > earlier chat or draft fact. One level wins (message, then
  // confirmed, then the newest earlier statement); topics come from the message and the person's previous message only.
  const weights: Record<string, number> = {};
  const put = (tag: string, w: number) => { if (!(weights[tag] >= w)) weights[tag] = w; };
  const msgSig = signalsOf(o.message);
  const levelOf = (t: string): Level | null => levelOfFact(t);
  let level: Level | null = msgSig.level, levelStatus: Status = level ? "said" : "unknown", levelFrom = level ? "this message" : undefined;
  if (!level) {
    for (const f of confirmedF) { const l = levelOf(String(f.text)); if (l) { level = l; levelStatus = "confirmed"; levelFrom = f.id; break; } }
  }
  if (!level) {
    for (const f of draftF) { const l = levelOf(String(f.text)); if (l) { level = l; levelStatus = "said"; levelFrom = `${f.id} (not confirmed)`; break; } }
  }
  if (!level) for (const t of userTurns) { const l = levelOf(t); if (l) { level = l; levelStatus = "said"; levelFrom = "earlier in this chat"; break; } }
  if (level) put(`stage:${level}`, msgSig.level ? W_MESSAGE : levelStatus === "confirmed" ? W_CONFIRMED : W_CHAT);

  const overlayStatus: Record<string, Status> = {};
  const addOverlay = (tag: string, w: number, st: Status) => { put(tag, w); if (!overlayStatus[tag] || st === "confirmed") overlayStatus[tag] = st; };
  for (const tag of msgSig.tags) { if (tag.startsWith("stage:") && LEVELS.includes(tag.slice(6) as Level)) continue; if (isTopic(tag)) put(tag, W_MESSAGE); else addOverlay(tag, W_MESSAGE, "said"); }
  for (const f of confirmedF) for (const tag of signalsOf(String(f.text)).tags) { if (tag.startsWith("stage:") && LEVELS.includes(tag.slice(6) as Level)) continue; if (!isTopic(tag)) addOverlay(tag, W_CONFIRMED, "confirmed"); }
  for (const f of draftF) for (const tag of signalsOf(String(f.text)).tags) { if (!isTopic(tag)) addOverlay(tag, W_CHAT, "said"); }
  for (const t of userTurns) for (const tag of signalsOf(t).tags) { if (!isTopic(tag) && !tag.startsWith("stage:")) addOverlay(tag, W_CHAT, "said"); }
  // The person's previous message sets the topic of a follow-up ("how do I get those?").
  if (userTurns[0]) for (const tag of signalsOf(userTurns[0]).tags) if (isTopic(tag)) put(tag, W_CHAT);
  // Overlays like career_changer that a person states about themselves also count when earlier chat said them.
  for (const t of userTurns) for (const tag of signalsOf(t).tags) if (tag.startsWith("stage:") && !LEVELS.includes(tag.slice(6) as Level)) addOverlay(tag, W_CHAT, "said");

  // "I want to get into X" from someone who already works in something else is a career change.
  const hasExp = facts.some((f: any) => f.kind === "experience");
  if ((!level || level === "mid_career") && (switchIntent(o.message) || (wantsSwitch(o.message) && hasExp))) addOverlay("stage:career_changer", W_MESSAGE, "said");

  const eduC = texts(confirmedF, ["education"]), eduD = texts(draftF, ["education"]);
  const majorChat = chat.map(majorOf).find(Boolean) ?? null;
  const majorC = eduC.map(majorOf).find(Boolean) ?? null;
  const majorS = eduD.map(majorOf).find(Boolean) ?? majorChat;
  const projC = texts(confirmedF).filter((t) => PROJECT.test(t)), projD = texts(draftF).filter((t) => PROJECT.test(t));
  const expC = texts(confirmedF, ["experience"]).filter((t) => !projC.includes(t)), expD = texts(draftF, ["experience"]).filter((t) => !projD.includes(t));
  const authC = texts(confirmedF).find((t) => AUTH.test(t)) ?? null;
  const authS = texts(draftF).find((t) => AUTH.test(t)) ?? chat.find((t) => AUTH.test(t)) ?? null;
  const dlC = texts(confirmedF).filter((t) => DEADLINE.test(t)), dlD = texts(draftF).filter((t) => DEADLINE.test(t)).concat(chat.filter((t) => DEADLINE.test(t)).map((t) => clip(t, 120)));
  const conC = [...(o.standing ?? []).filter((s) => s && typeof s.text === "string" && !personalSourceGuard([o.standing])(s)).map((s) => s.text), ...(pref.compFloor ? [`pay floor ${pref.compFloor}`] : []), ...(pref.remote ? [`remote: ${pref.remote}`] : []), ...texts(confirmedF, ["preference"])];
  const confC = texts(confirmedF).find((t) => signalsOf(t).tags.has("ctx:low_confidence")) ?? null;
  const confS = draftF.map((f: any) => String(f.text)).find((t) => signalsOf(t).tags.has("ctx:low_confidence")) ?? chat.find((t) => signalsOf(t).tags.has("ctx:low_confidence")) ?? null;
  const goalC = [...strs(pref.roles), ...texts(confirmedF, ["goal"])], goalD = texts(draftF, ["goal"]);
  const placeC = [...strs(pref.locations), ...(basics.location ? [String(basics.location)] : []), ...texts(confirmedF, ["location"])], placeD = texts(draftF, ["location"]);

  const pack: ContextPack = {
    stage: level ? { value: level.replace("_", " "), status: levelStatus, from: levelFrom } : { value: null, status: "unknown" },
    overlays: Object.entries(overlayStatus).filter(([tag]) => tag.startsWith("stage:") || ["ctx:international", "ctx:nontarget", "ctx:low_gpa", "ctx:first_gen"].includes(tag)).map(([tag, status]) => ({ tag, status })),
    education: list(eduC, eduD),
    major: one(majorC, majorS),
    experience: list(expC, expD),
    skills: list(texts(confirmedF, ["skill"]), texts(draftF, ["skill"])),
    projects: list(projC, projD),
    goals: list(goalC, goalD),
    places: list(placeC, placeD),
    constraints: list(conC, []),
    authorization: one(authC ? clip(authC) : null, authS ? clip(authS) : null),
    deadlines: list(dlC, dlD),
    confidence: one(confC ? clip(confC) : null, confS ? clip(confS) : null),
    said_in_chat: userTurns.slice(0, 3).map((t) => clip(t, 160)),
    alerts: o.alertsLine ?? null,
    in_flight: o.situation?.tasks?.length ? `${o.situation.tasks.length} task(s) in flight${o.situation.next?.[0] ? `; next: ${clip(o.situation.next[0].what, 100)}` : ""}` : null,
    unknown: [],
    weights,
  };
  if (!pack.overlays.some((x) => x.tag === "ctx:low_gpa") && weights["ctx:low_gpa"]) pack.overlays.push({ tag: "ctx:low_gpa", status: "said" });
  pack.unknown = unknownFacts(pack);
  return pack;
}

// The facts that would most change advice, in order, that nothing says. At most five.
export function unknownFacts(p: ContextPack): string[] {
  const out: string[] = [];
  const student = ["freshman", "sophomore", "junior", "senior", "grad student"].includes(p.stage.value ?? "");
  if (p.stage.status === "unknown") out.push("career stage (year in school, new graduate, changing careers, returning)");
  if (student && p.major.status === "unknown") out.push("major or field of study");
  if (p.goals.status === "unknown") out.push("target role or field");
  if (p.places.status === "unknown" && !p.weights["ctx:remote"]) out.push("place, or whether remote");
  if (p.experience.status === "unknown" && p.projects.status === "unknown") out.push("experience or projects so far");
  if (p.authorization.status === "unknown" && (p.weights["ctx:international"] || p.weights["ctx:relocation"])) out.push("work authorization and when it ends");
  if (p.deadlines.status === "unknown") out.push("timeline or deadline");
  return out.slice(0, 5);
}

const tag = (s: Status, from?: string) => (s === "confirmed" ? `confirmed${from ? ` ${from}` : ""}` : s === "said" ? "said, not confirmed" : "unknown");
const val = (k: Known<string>) => (k.value ? `${k.value} [${tag(k.status, k.from)}]` : "unknown");
const lst = (k: Known<string[]>) => (k.value ? `${k.value.join("; ")} [${tag(k.status)}]` : "unknown");

// The block for the system prompt. Stable shape, every field present, so the model reads "unknown" rather than guessing.
export function contextPackBlock(p: ContextPack): string {
  const lines = [
    "PERSON CONTEXT PACK. Built by code from this person's account and what they said in this chat. \"confirmed\" is usable anywhere; \"said, not confirmed\" is fine to advise from but never to put in an application; \"unknown\" is not known: never assume it.",
    `- Stage: ${val(p.stage)}`,
    ...(p.overlays.length ? [`- Also: ${p.overlays.map((o) => `${o.tag.split(":")[1].replace(/_/g, " ")} [${tag(o.status)}]`).join(", ")}`] : []),
    `- Education: ${lst(p.education)}`,
    `- Major: ${val(p.major)}`,
    `- Experience: ${lst(p.experience)}`,
    `- Skills: ${lst(p.skills)}`,
    `- Projects: ${lst(p.projects)}`,
    `- Goals (roles/fields): ${lst(p.goals)}`,
    `- Places: ${lst(p.places)}`,
    `- Constraints and standing instructions: ${lst(p.constraints)}`,
    `- Work authorization: ${val(p.authorization)}`,
    `- Deadlines and timing: ${lst(p.deadlines)}`,
    `- How they feel about it: ${val(p.confidence)}`,
    `- Saved alerts: ${p.alerts ?? "none"}`,
    `- In flight: ${p.in_flight ?? "nothing"}`,
    ...(p.said_in_chat.length ? ["- Their last messages here (newest first): " + p.said_in_chat.map((t) => `"${t}"`).join(" | ")] : []),
    p.unknown.length
      ? `Not known yet (ask about AT MOST ONE, only if the answer would change your advice; otherwise give the full answer first and state your assumption): ${p.unknown.join("; ")}.`
      : "Nothing important is unknown; do not ask for anything already above.",
  ];
  return lines.join("\n");
}
