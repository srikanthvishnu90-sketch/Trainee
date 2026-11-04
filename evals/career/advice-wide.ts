// Deterministic wide grader for open career questions (flag CAREER_KNOWLEDGE): 340 seeds across fields, ages and stages.
// Free, offline, no model: routing is the real stagedDecision (router probe + open-question regex), the field and stage come from
// the real understand(), the brief and the Telegram paragraph from the real pipeline with an EMPTY search (the harshest case: no
// source, so every number must be absent and the brief must say so). The paragraph is the code floor (fallbackVerdict): what the
// person gets when the model's own paragraph fails the lint. A 10/10 floor means the model only has to be better, never worse.
//   deno run -A evals/career/advice-wide.ts [--show] [--only W012]
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { researchCareerQuestion } from "../../supabase/functions/_shared/agent/research/index.ts";
import { fallbackVerdict } from "../../supabase/functions/_shared/agent/research/reply.ts";
import { lintChat } from "../../supabase/functions/_shared/agent/research/chat.ts";
import { detectField } from "../../supabase/functions/_shared/agent/research/understand.ts";
import { DEGREE_ASK, LATE_ASK, shortFor, WORTH_ASK } from "../../supabase/functions/_shared/agent/research/shorts.ts";
import { unsourcedIn } from "../../supabase/functions/_shared/agent/research/guard.ts";

export const LINK = "https://files.example/brief/plan.md";
const NOW = Date.parse("2026-10-30T12:00:00Z");

// id = the catalog field the real detector must pick, or "other" (the model names it; code builds a generic field)
interface Occ { a: string; field: string; major: string; id: string; local?: boolean; soft?: boolean }
export const OCCS: Occ[] = [
  { a: "an investment banker", field: "investment banking", major: "investment banking", id: "ib" },
  { a: "a management consultant", field: "consulting", major: "management consulting", id: "consulting" },
  { a: "a software engineer", field: "software engineering", major: "computer science", id: "swe", soft: true },
  { a: "a data analyst", field: "data analytics", major: "statistics", id: "data", soft: true },
  { a: "a registered nurse", field: "nursing", major: "nursing", id: "nursing", local: true },
  { a: "an electrician", field: "the electrical trade", major: "electrical technology", id: "trades", local: true },
  { a: "a plumber", field: "plumbing", major: "plumbing technology", id: "trades", local: true },
  { a: "a high school teacher", field: "teaching", major: "teaching", id: "teaching", local: true },
  { a: "a product manager", field: "product management", major: "business", id: "other", soft: true },
  { a: "a mechanical engineer", field: "mechanical engineering", major: "mechanical engineering", id: "eng" },
  { a: "an instructional designer", field: "instructional design", major: "education", id: "lnd" },
  { a: "a lawyer", field: "law", major: "political science", id: "other", local: true },
  { a: "a paralegal", field: "paralegal work", major: "paralegal studies", id: "other" },
  { a: "a physician assistant", field: "physician assistant work", major: "biology", id: "other", local: true },
  { a: "a pharmacist", field: "pharmacy", major: "chemistry", id: "other", local: true },
  { a: "a dental hygienist", field: "dental hygiene", major: "dental hygiene", id: "other", local: true },
  { a: "a physical therapist", field: "physical therapy", major: "kinesiology", id: "other", local: true },
  { a: "a radiology technologist", field: "radiologic technology", major: "radiologic technology", id: "other", local: true },
  { a: "an accountant", field: "accounting", major: "accounting", id: "other" },
  { a: "a financial advisor", field: "financial planning", major: "finance", id: "other", local: true },
  { a: "a graphic designer", field: "graphic design", major: "graphic design", id: "other" },
  { a: "a filmmaker", field: "film production", major: "film", id: "other" },
  { a: "a working musician", field: "music", major: "music", id: "other" },
  { a: "a journalist", field: "journalism", major: "journalism", id: "other" },
  { a: "a police officer", field: "law enforcement", major: "criminal justice", id: "other", local: true },
  { a: "a firefighter", field: "firefighting", major: "fire science", id: "other", local: true },
  { a: "an HVAC technician", field: "HVAC", major: "HVAC technology", id: "trades", local: true },
  { a: "a welder", field: "welding", major: "welding technology", id: "trades", local: true },
  { a: "a commercial truck driver", field: "trucking", major: "transportation", id: "other", local: true },
  { a: "an airline pilot", field: "commercial aviation", major: "aviation", id: "other" },
  { a: "a social worker", field: "social work", major: "social work", id: "other", local: true },
  { a: "a psychologist", field: "psychology", major: "psychology", id: "other", local: true },
  { a: "an architect", field: "architecture", major: "architecture", id: "other", local: true },
  { a: "a chef", field: "the culinary field", major: "culinary arts", id: "other" },
  { a: "a real estate agent", field: "real estate", major: "business", id: "other", local: true },
  { a: "a cybersecurity analyst", field: "cybersecurity", major: "cybersecurity", id: "other", soft: true },
  { a: "a UX designer", field: "UX design", major: "design", id: "other", soft: true },
  { a: "a marketing manager", field: "marketing", major: "marketing", id: "other" },
  { a: "an HR generalist", field: "human resources", major: "human resources", id: "other" },
  { a: "a civil engineer", field: "civil engineering", major: "civil engineering", id: "eng", local: true },
  { a: "a veterinary technician", field: "veterinary technology", major: "veterinary technology", id: "other", local: true },
  { a: "an occupational therapist", field: "occupational therapy", major: "occupational therapy", id: "other", local: true },
  { a: "a wind turbine technician", field: "wind energy", major: "renewable energy", id: "other" },
  { a: "a wildlife biologist", field: "wildlife biology", major: "biology", id: "other" },
  { a: "a librarian", field: "library science", major: "library science", id: "other" },
  { a: "a sales representative", field: "sales", major: "business", id: "other" },
];
export type Stage = "early_student" | "late_student" | "new_grad" | "grad_student" | "switcher" | "displaced" | "experienced" | "unknown";
interface Ctx { id: string; pre: string; stage: Stage; group: string; overlay?: string; alt?: Stage[] }
export const CTXS: Ctx[] = [
  { id: "none", pre: "", stage: "unknown", group: "no context" },
  { id: "fresh", pre: "I'm a freshman in college.", stage: "early_student", group: "student" },
  { id: "soph", pre: "I'm a sophomore.", stage: "early_student", group: "student" },
  { id: "junior", pre: "I'm a junior in college.", stage: "late_student", group: "student" },
  { id: "senior", pre: "I'm a senior.", stage: "late_student", group: "student" },
  { id: "hs", pre: "I'm a junior in high school.", stage: "early_student", group: "high school", overlay: "high_school" },
  { id: "hs2", pre: "I'm 16.", stage: "early_student", group: "high school", overlay: "high_school" },
  { id: "cc", pre: "I'm at a community college.", stage: "early_student", group: "student", overlay: "cc" },
  { id: "grad", pre: "I just graduated.", stage: "new_grad", group: "new grad" },
  { id: "msgrad", pre: "I'm in a master's program.", stage: "grad_student", group: "grad" },
  { id: "mba", pre: "I'm in an MBA program.", stage: "grad_student", group: "grad" },
  { id: "phd", pre: "I'm finishing my PhD.", stage: "grad_student", group: "grad" },
  { id: "change", pre: "I'm a career changer.", stage: "switcher", group: "career changer" },
  { id: "age40", pre: "I'm 42 and want a change.", stage: "switcher", alt: ["experienced"], group: "40+" },
  { id: "age47", pre: "I'm 47 and have worked in retail for twenty years.", stage: "switcher", alt: ["experienced"], group: "40+" },
  { id: "age55", pre: "I'm 55 and looking to start over.", stage: "switcher", alt: ["experienced"], group: "40+", overlay: "older" },
  { id: "vet", pre: "I'm a veteran, separating from the Army next spring.", stage: "experienced", alt: ["switcher"], group: "military to civilian", overlay: "veteran" },
  { id: "vet2", pre: "I just left the Navy after six years.", stage: "experienced", alt: ["switcher"], group: "military to civilian", overlay: "veteran" },
  { id: "laid", pre: "I got laid off last month.", stage: "displaced", group: "laid off" },
  { id: "parent", pre: "I'm a parent returning to work after six years at home.", stage: "switcher", alt: ["experienced"], group: "career changer" },
  { id: "intl", pre: "I'm an international student on F-1.", stage: "unknown", alt: ["switcher"], group: "student", overlay: "intl" },
];
interface Phr { id: string; text: (o: Occ) => string }
export const PHRS: Phr[] = [
  { id: "hired", text: (o) => `How do I get hired as ${o.a}?` },
  { id: "takes", text: (o) => `What does it take to become ${o.a}?` },
  { id: "worth", text: (o) => `Is ${o.field} worth it?` },
  { id: "major", text: (o) => `Should I major in ${o.major}?` },
  { id: "path", text: (o) => `What's the path to becoming ${o.a}?` },
  { id: "long", text: (o) => `How long does it take to become ${o.a}?` },
  { id: "degree", text: (o) => `Do I need a degree to be ${o.a}?` },
  { id: "late", text: (o) => `Is it too late for me to become ${o.a}?` },
  { id: "old", text: (o) => `Am I too old to become ${o.a}?` },
  { id: "start", text: (o) => `Where do I even start if I want to be ${o.a}?` },
  { id: "land", text: (o) => `What should I do to land a job as ${o.a}?` },
  { id: "breakin", text: (o) => `How do I break into ${o.field}?` },
  { id: "pay", text: (o) => `What does ${o.a} make, and is the career a good bet?` },
];
export interface WSeed { id: string; group: string; message: string; occ: Occ; ctx: Ctx; phr: string }
export function wideSeeds(n = 340): WSeed[] {
  const out: WSeed[] = [];
  for (let i = 0; i < n; i++) {
    const occ = OCCS[i % OCCS.length], ctx = CTXS[(i * 7 + Math.floor(i / OCCS.length)) % CTXS.length], phr = PHRS[(i * 5 + Math.floor(i / 3)) % PHRS.length];
    out.push({ id: `W${String(i + 1).padStart(3, "0")}`, group: ctx.group, message: `${ctx.pre ? ctx.pre + " " : ""}${phr.text(occ)}`, occ, ctx, phr: phr.id });
  }
  return out;
}

const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-wide", threadId: "t-wide", now: NOW, snapshot: null, accountPersistence: true });
const ENV = { get: (k: string) => ({ CAREER_BRAIN: "staged", CAREER_KNOWLEDGE: "on" } as Record<string, string>)[k] };
const SOFTWARE = /\b(leetcode|github|python|coding|software|resume bullets? with metrics)\b/i;

export const CAUSES = ["names_field", "duplicate", "no_direct_answer", "route", "field", "stage", "overlay", "chat_lint", "chat_shape", "unsourced", "software_default", "brief_shape", "ask", "hallucinated_number"] as const;
export type Cause = typeof CAUSES[number];
export interface Graded { id: string; message: string; fails: { cause: Cause; why: string }[]; chat: string; brief: string }

export async function gradeSeed(s: WSeed): Promise<Graded> {
  const fails: Graded["fails"] = [], bad = (cause: Cause, why: string) => fails.push({ cause, why });
  const d = stagedDecision({ env: ENV, message: s.message, ctx: fresh(), host, structured: false });
  if (!d.brain) bad("route", `${d.reason}/${d.intent}`);
  const cat = detectField(s.message);
  if (s.occ.id === "other" ? !!cat : cat?.id !== s.occ.id) bad("field", `detected ${cat?.id ?? "none"}, expected ${s.occ.id}`);
  const derive = async () => ({ label: s.occ.field.replace(/^the /, "").toLowerCase(), local: !!s.occ.local });
  const none = async () => ({ status: "ok" as const, facts: [], urls: [], cost_usd: 0 });
  const r = await researchCareerQuestion({ message: s.message, profile: { facts: [] }, deps: { search: none, publish: async () => ({ url: LINK }), derive }, now: NOW });
  if (r.status !== "ok") { bad("field", `pipeline asked: ${r.ask}`); return { id: s.id, message: s.message, fails, chat: "", brief: "" }; }
  const md = r.brief_markdown, chat = fallbackVerdict(r);
  const stageLine = /Written for ([^\n]*?) aiming/.exec(md)?.[1] ?? "";
  const WANT = { early_student: "an early-stage student", late_student: "a student near graduation", new_grad: "a new graduate", grad_student: "a graduate student", switcher: "a career changer", displaced: "someone between jobs after a layoff", experienced: "an experienced professional", unknown: "someone early in their career" } as Record<Stage, string>;
  const okStages = [s.ctx.stage, ...(s.ctx.alt ?? [])].map((x) => WANT[x]);
  if (!okStages.includes(stageLine)) bad("stage", `brief says "${stageLine}", expected "${okStages[0]}"`);
  if (s.ctx.stage !== "unknown" && /I don't know your stage/.test(md)) bad("stage", "asked about stage the message stated");
  if (s.ctx.overlay) {
    const hs = s.ctx.overlay === "high_school";
    if (hs ? !/high school|school counselor/i.test(md) : !new RegExp({ cc: "community college|transfer", older: "Experience is your asset", veteran: "service is real experience", intl: "work authorization" }[s.ctx.overlay] ?? "$^", "i").test(md)) bad("overlay", `${s.ctx.overlay} context not reflected`);
  }
  const LEADS: Record<string, RegExp> = { high_school: /At your age/, veteran: /service counts/, older: /experience is the asset/, intl: /work authorization/, cc: /transfer-credit/ };
  if (s.ctx.overlay && LEADS[s.ctx.overlay] && !LEADS[s.ctx.overlay].test(chat)) bad("overlay", `paragraph ignores ${s.ctx.overlay}`);
  // reviewer checks: the paragraph names the occupation, and asked "worth it" / "need a degree" questions get a direct answer line
  const low = chat.toLowerCase();
  if (![...s.occ.field.split(" ").filter((w) => w.length > 4), s.occ.a.split(" ").pop()!].some((w) => low.includes(w.toLowerCase()))) bad("names_field", "paragraph never names the occupation");
  if (WORTH_ASK.test(s.message) || DEGREE_ASK.test(s.message) || LATE_ASK.test(s.message)) {
    if (!/^Realistically,/.test(chat)) bad("no_direct_answer", "asked worth/degree, no direct answer first");
    if (!/\*\*Your question\.\*\*/.test(md)) bad("no_direct_answer", "brief has no Your question line");
  }
  const lint = lintChat(chat, { link: LINK, facts: r.facts, person: r.person, message: s.message });
  for (const l of lint) bad("chat_lint", l);
  const w = chat.replace(LINK, "").trim().split(/\s+/).length;
  if (!chat.endsWith(LINK)) bad("chat_shape", "no link");
  if (!/\bthis week\b/i.test(chat)) bad("chat_shape", "no this-week action");
  if ((chat.match(/\bthis week\b/gi) ?? []).length > 1) bad("chat_shape", "this week repeated");
  if (w < 40 || w > 95) bad("chat_shape", `${w} words`);
  if (/\d/.test(chat.replace(LINK, ""))) bad("hallucinated_number", "digit in paragraph with no source");
  const un = unsourcedIn(md, { facts: r.facts, person: r.person, message: s.message });
  if (un.length) bad("unsourced", un.slice(0, 3).join(", "));
  if (!s.occ.soft && SOFTWARE.test(md.replace(/Written for[^\n]*/, ""))) bad("software_default", (SOFTWARE.exec(md) ?? [""])[0]);
  for (const h of ["Honest read", "Honest odds", "Networking plan", "What I couldn't verify", "Your next three actions"]) if (!md.includes(`## ${h}`)) bad("brief_shape", `missing ${h}`);
  if (![s.occ.field.replace(/^the /, "").split(" ")[0], s.occ.a.split(" ").pop()!].some((w) => md.toLowerCase().includes(w.toLowerCase()))) bad("brief_shape", "brief never names the field");
  if (r.ask && !s.occ.local) bad("ask", r.ask);
  if (s.occ.local && /Which state are you in/.test(r.ask ?? "") === false && !/Assuming you're in the US/.test(md)) bad("ask", "licensed field with no state ask or assumption");
  return { id: s.id, message: s.message, fails, chat, brief: md };
}
// Two different occupations must never get a byte-identical "Later ... This week ..." core (the generic paragraph the reviewer found).
export function duplicates(seeds: WSeed[], rows: Graded[]): Graded[] {
  const by = new Map<string, Set<string>>();
  rows.forEach((r, i) => { const core = r.chat.replace(/https?:\S+/, "").replace(/^.*?(Later,)/s, "$1").trim(); if (!by.has(core)) by.set(core, new Set()); by.get(core)!.add(seeds[i].occ.field); });
  const dup = new Set([...by].filter(([, v]) => v.size > 1).flatMap(([, v]) => [...v]));
  for (const r of rows) { /* mark below */ }
  rows.forEach((r, i) => { if (dup.has(seeds[i].occ.field)) r.fails.push({ cause: "duplicate", why: `${seeds[i].occ.field} shares a paragraph core with another occupation` }); });
  return rows;
}
export function summarize(rows: Graded[]) {
  const by = new Map<string, number>(), ex = new Map<string, string>();
  for (const r of rows) for (const f of r.fails) { by.set(f.cause, (by.get(f.cause) ?? 0) + 1); if (!ex.has(f.cause)) ex.set(f.cause, `${r.id} "${r.message}": ${f.why}`); }
  const pass = rows.filter((r) => !r.fails.length).length;
  return { pass, total: rows.length, score: pass / rows.length, causes: [...by].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ cause: c, n, example: ex.get(c)! })) };
}
if (import.meta.main) {
  const only = Deno.args[Deno.args.indexOf("--only") + 1], seeds = wideSeeds().filter((s) => !Deno.args.includes("--only") || s.id === only);
  const rows: Graded[] = [];
  for (const s of seeds) rows.push(await gradeSeed(s));
  duplicates(seeds, rows);
  const sum = summarize(rows);
  console.log(`${sum.pass}/${sum.total} seeds clean (${(sum.score * 100).toFixed(1)}%)`);
  for (const c of sum.causes) console.log(`  ${String(c.n).padStart(4)}  ${c.cause}  e.g. ${c.example}`);
  if (Deno.args.includes("--show")) for (const r of rows.slice(0, 3)) console.log(`\n${r.message}\n${r.chat}`);
  Deno.exit(sum.pass === sum.total ? 0 : 1);
}
