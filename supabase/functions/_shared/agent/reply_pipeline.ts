// REPLY PIPELINE (docs/architect/specs/REPLY-PIPELINE.md): evidence ledger -> tagged draft -> verify against the cited units only ->
// one repair pass -> drop -> code's fallback line. One mechanism for every reply that rests on research, a posting or the record;
// nothing here knows any turn of any test set.
//
//   ledger    numbered evidence units, each from one of three places: a page unit (one sentence or table row, with its host and
//             kind), this chat's tool results (a posting's pay by place, its deadline and state, a search's count, a file made), or
//             the person's confirmed record, what it lacks included ("not on file: city, phone").
//   draft     the drafting model gets the units (LEDGER_RULE + Ledger.block()) and tags each factual sentence [E3] or [E3,E7]. A
//             sentence with no figure, name or date needs no tag (support.ts noClaim), nor does a question with no figure.
//   verify    each clause of a tagged sentence (support.ts clausesOf) against the units it cites and nothing else: layer A
//             (findSupport on an index of those units), then the judge, in one batch. Tags are removed before sending.
//   repair    ONE model call for everything that failed (a sentence, the length, the task contract), each with code's reason in
//             code's words; the answer is verified again; what still fails is dropped. It replaces the shortener and the quote fallback.
//   fallback  after the drop, when nothing left answers, code says what it could not verify and what the ledger holds (a posting's
//             pay with its link).
import { clausesOf, findSupport, hardParts, indexPages, judgeAll, nameFoundIn, noClaim, personQuestion, splitSentences, type SupportJudge } from "./research/support.ts";

// ON (ruling 2026-11-14): the drafting prompt asks for tags and every tool result carries its units. The path is chosen by the draft:
// a TAGGED draft goes through this pipeline (no page quote is ever put in place of a sentence); an UNTAGGED one (a model that ignored
// the tags, a scripted test) keeps the support check unchanged, its quote fallback included. The trace says which (`pipeline`).
export const PIPELINE = { on: true };
export const isTagged = (t: string) => /\[E\d+(?:\s*,\s*E\d+)*\]/.test(String(t ?? ""));
export type EvidenceKind = "page" | "chat" | "record" | "absent";
export interface EvidenceUnit { id: string; kind: EvidenceKind; text: string; host?: string | null; url?: string | null; source?: string; places?: string[] }

export class Ledger {
  units: EvidenceUnit[] = [];
  add(kind: EvidenceKind, text: string, meta: { host?: string | null; url?: string | null; source?: string; places?: string[] } = {}): string {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const had = this.units.find((u) => u.kind === kind && u.text === t && (u.url ?? null) === (meta.url ?? null));
    if (had) return had.id;
    const id = `E${this.units.length + 1}`;
    this.units.push({ id, kind, text: t, ...meta });
    return id;
  }
  get(id: string): EvidenceUnit | undefined { return this.units.find((u) => u.id === id); }
  // What a tool returned, as units, by the shape of what it returned (never by tool or turn): posting records, pages' units, counts,
  // files made. Returns the ids added.
  fromToolResult(name: string, out: unknown): string[] {
    const ids: string[] = [];
    const o = (out && typeof out === "object" ? out : null) as Record<string, any> | null;
    if (!o) return ids;
    const postings: any[] = [...(Array.isArray(o.postings) ? o.postings : []), ...(Array.isArray(o.results) ? o.results : []), ...(o.posting && typeof o.posting === "object" ? [o.posting] : [])];
    for (const p of postings) {
      const who = [p?.company, p?.title].filter((x) => typeof x === "string" && x.trim()).join(", ");
      const url = typeof p?.url === "string" ? p.url : typeof o.url === "string" ? o.url : null;
      // (the posting's own places, so layer A reads "Chicago, IL" there as a place, never as an owner)
      const places = [p?.location, ...String(p?.pay ?? "").split(/;\s*/).map((x: string) => /^([^:]+):/.exec(x)?.[1])].filter((x): x is string => typeof x === "string" && /,/.test(x)).map((x) => x.trim());
      if (typeof p?.pay === "string" && p.pay.trim()) for (const part of p.pay.split(/;\s*/)) ids.push(this.add("chat", `${who}${p?.location ? ` (${p.location})` : ""}: pay ${part.trim()}`, { url, source: name, places }));
      const dl = [p?.deadline, p?.closes, p?.close_date].find((x) => typeof x === "string" && x.trim());
      const st = typeof p?.state === "string" ? p.state : null;
      if (st || dl) ids.push(this.add("chat", `${who}: the posting is ${st ?? "listed"}${dl ? `; it closes ${dl}` : ""}.`, { url, source: name }));
    }
    if (Array.isArray(o.postings)) ids.push(this.add("chat", `The search (${name}) returned ${o.postings.length} posting${o.postings.length === 1 ? "" : "s"}.`, { source: name }));
    const req = o.requirements && typeof o.requirements === "object" ? o.requirements : null;
    if (req) for (const k of ["required", "preferred"]) for (const x of Array.isArray(req[k]) ? req[k] : []) if (typeof x === "string") ids.push(this.add("chat", `The posting ${k === "required" ? "requires" : "prefers"}: ${x}`, { source: name }));
    if (o.sign_in_required === true) ids.push(this.add("chat", "To apply, the person signs in to the employer's careers site themselves; its own questions are behind that sign-in and were not read.", { source: name }));
    for (const s of Array.isArray(o.sources) ? o.sources : []) for (const pt of [...(Array.isArray(o.points) ? o.points : []), ...(Array.isArray(o.summary) ? o.summary : [])])
      if (Array.isArray(pt?.cite) && pt.cite.includes(s?.n) && typeof pt?.text === "string") ids.push(this.add("page", pt.text, { url: s?.url ?? null, host: hostOf(s?.url), source: s?.kind ?? "reported" }));
    const link = typeof o.url === "string" && /file|tracker|page/i.test(name) ? o.url : null;
    if (link) ids.push(this.add("chat", `A ${name.replace(/_/g, " ")} file was made this turn.`, { url: link, source: name }));
    return ids.filter(Boolean);
  }
  // The person's confirmed record, a fact per unit, and what it lacks.
  addRecord(facts: string[], absent: string[] = []): void {
    for (const f of facts) this.add("record", f, { source: "record" });
    if (absent.length) this.add("absent", `Not on file: ${absent.join(", ")}.`, { source: "record" });
  }
  block(ids?: string[]): string {
    const us = ids ? this.units.filter((u) => ids.includes(u.id)) : this.units;
    return us.map((u) => `[${u.id}] (${u.kind === "page" ? `page${u.host ? ` ${u.host}` : ""}${u.source ? `, ${u.source}` : ""}` : u.kind === "chat" ? "this chat's tool result" : u.kind === "absent" ? "the person's record lacks" : "the person's confirmed record"}) ${u.text}`).join("\n");
  }
}
const hostOf = (u: unknown) => { try { return typeof u === "string" ? new URL(u).hostname : null; } catch { return null; } };

export const LEDGER_RULE = "EVIDENCE: the numbered units below (and any `evidence` in a tool result) are the only facts you may state about the world, " +
  "the posting or the person. End each factual sentence with the ids it rests on, like [E3] or [E3,E7]; a sentence with no figure, name or date " +
  "needs none, and neither does a question. Never cite a unit that does not state what the sentence says. Code removes the tags.";

const TAG = /\s*\[(E\d+(?:\s*,\s*E\d+)*)\]/g;
export function tagsOf(sentence: string): { ids: string[]; text: string } {
  const ids = [...String(sentence ?? "").matchAll(TAG)].flatMap((m) => m[1].split(/\s*,\s*/));
  return { ids: [...new Set(ids)], text: String(sentence ?? "").replace(TAG, "").replace(/\s+([.,;:!?])/g, "$1").trim() };
}
export const stripTags = (t: string) => String(t ?? "").replace(TAG, "").replace(/[ \t]+([.,;:!?])/g, "$1");

export interface Failure { sentence: string; reason: string }
export interface Verified { text: string; failures: Failure[]; kept: string[]; cites: string[] }

// What layer A found missing, in code's words: each figure, name or date of the clause that no cited unit holds.
export function missingSpecifics(clause: string, units: EvidenceUnit[]): string[] {
  const all = units.map((u) => u.text).join(" \n ").toLowerCase(), h = hardParts(clause);
  const names = h.names.map((r, j) => j === 0 && r[0] === h.first ? r.slice(1) : r).filter((r) => r.length).map((r) => r.join(" "));
  const figs = [...String(clause).matchAll(/(?:[$€£]\s?)?\d[\d,.]*(?:\s?(?:k|%|percent|days? ago|hours?|an hour|a year|per \w+))?/gi)].map((m) => m[0].trim());
  const digits = (f: string) => (/\d[\d,.]*/.exec(f)?.[0] ?? "").replace(/[.,]$/, "");
  const out = [...figs.filter((f) => !all.includes(digits(f))), ...names.filter((n) => !all.includes(n.replace(/^date(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")))];
  return [...new Set(out)];
}

// Verify a tagged reply against its ledger: what stands (tags removed), and every failure with its reason.
export async function verifyTagged(reply: string, ledger: Ledger, o: { judge?: SupportJudge | null; own?: string[]; onRecord?: (s: string) => boolean | null; ask?: string } = {}): Promise<Verified> {
  // (a question to the person may name only what their own record or their ask names)
  const allowed = [String(o.ask ?? ""), ...ledger.units.filter((u) => u.kind === "record").map((u) => u.text)].join("\n");
  const own = new Set((o.own ?? []).map((x) => x.trim()));
  const lines = String(reply ?? "").split("\n").map((l) => /^\s*(?:https?:\/\/\S+\s*)*$/.test(l) ? [l] : splitSentences(l).filter((x) => x.trim()));
  const failures: Failure[] = [], kept: string[] = [];
  const checks: { a: number; b: number; clause: string; units: EvidenceUnit[]; claim: string }[] = [];
  const bad = new Set<string>(), citeAt = new Map<string, string[]>();
  lines.forEach((l, a) => l.forEach((x, b) => {
    if (/^\s*(?:https?:\/\/\S+\s*)*$/.test(x)) return;
    const { ids, text } = tagsOf(x);
    lines[a][b] = text;
    if (!/\p{L}/u.test(text) || own.has(text) || noClaim(text) || personQuestion(text, allowed)) return;
    if (o.onRecord?.(text) === true) return;
    if (!ids.length) { failures.push({ sentence: text, reason: "it states a fact and cites no evidence unit" }); bad.add(`${a}:${b}`); return; }
    const units = ids.map((id) => ledger.get(id)).filter(Boolean) as EvidenceUnit[];
    if (units.length < ids.length) { failures.push({ sentence: text, reason: `it cites ${ids.filter((id) => !ledger.get(id)).join(", ")}, which no evidence unit is` }); bad.add(`${a}:${b}`); return; }
    citeAt.set(`${a}:${b}`, ids);
    for (const c of clausesOf(text)) {
      if (noClaim(c) || personQuestion(c, allowed) || o.onRecord?.(c) === true) continue;
      if (o.onRecord?.(c) === false) { failures.push({ sentence: text, reason: `"${c}" is not what the person's record holds` }); bad.add(`${a}:${b}`); return; }
      checks.push({ a, b, clause: c, units, claim: text });
    }
  }));
  // Layer A: each clause against an index of the units it cites, a record unit read as one record (a fact per line).
  const asks: { k: number; claim: string; source: string }[] = [];
  checks.forEach((c, k) => {
    if (bad.has(`${c.a}:${c.b}`)) return;
    const idx = indexPages(c.units.map((u) => ({ text: u.text, title: u.kind === "page" ? `Page${u.host ? ` (${u.host})` : ""}` : u.kind === "chat" ? "This chat's tool result" : "The person's confirmed record:", places: u.places ?? [], ...(u.kind === "record" || u.kind === "absent" ? { one: true } : {}) })));
    const f = findSupport(c.clause, idx);
    if (!f) { const miss = missingSpecifics(c.clause, c.units); failures.push({ sentence: c.claim, reason: miss.length ? miss.map((m) => `'${m}' is in no cited unit`).join("; ") : `no single cited unit holds "${c.clause}"` }); bad.add(`${c.a}:${c.b}`); return; }
    asks.push({ k, claim: c.clause, source: f.unit.passage });
  });
  const got = await judgeAll(o.judge, asks.map((x) => ({ claim: x.claim, source: x.source })));
  asks.forEach((x, j) => { const c = checks[x.k]; if (!got[j] && !bad.has(`${c.a}:${c.b}`)) { failures.push({ sentence: c.claim, reason: `the cited unit does not state "${x.claim}"` }); bad.add(`${c.a}:${c.b}`); } });
  const text = lines.map((l, a) => l.filter((x, b) => x && !bad.has(`${a}:${b}`)).join(" ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const cites: string[] = [];
  lines.forEach((l, a) => l.forEach((x, b) => { if (x && !bad.has(`${a}:${b}`)) { kept.push(x); for (const id of citeAt.get(`${a}:${b}`) ?? []) if (!cites.includes(id)) cites.push(id); } }));
  return { text, failures, kept, cites };
}

// ------------------------------------------------------------------------------------------------ task contract
// What each intent's reply must contain, in one place, per intent (never per turn). `says` goes to the drafting model up front; `missing`
// is code's check, whose findings go to the repair pass.
export interface Contract { id: string; says: string; missing: (reply: string, ask: string) => string | null }
export const CONTRACTS: Record<string, Contract> = {
  referral: { id: "referral", says: "A referral message asks for the referral itself, plainly.", missing: (r) => /\brefer(?:ral|red|ring)?\b/i.test(r) ? null : "the message never asks for a referral" },
  answer_first: { id: "answer_first", says: "The answer comes first, in the first sentence; the detail after it.", missing: (r) => /^\s*(?:great question|good question|sure|absolutely|of course|happy to help|here(?:'s| is) (?:what|how)|let me|i'll|thanks for)/i.test(r) ? "the first sentence is a preamble, not the answer" : null },
  requirements: { id: "requirements", says: "A question about what is needed lists each thing needed.", missing: (r) => (r.match(/(?:^|\n)\s*(?:\d+[.)]|[-•])\s+/g) ?? []).length >= 2 || (r.match(/,|;/g) ?? []).length >= 2 ? null : "the reply does not list what is needed" },
  draft: { id: "draft", says: "A draft the person sends themselves says, after it, that it was not sent.", missing: (r) => /\bnot sent\b|\bnothing (?:was )?sent\b/i.test(r) ? null : "the draft is not marked as not sent" },
};
export function contractsFor(intent: string | null, message: string): Contract[] {
  const m = String(message ?? "").toLowerCase(), out: Contract[] = [CONTRACTS.answer_first];
  if (/\breferr?al\b|\brefer me\b/.test(m)) out.push(CONTRACTS.referral);
  if (/\bdraft|write (?:a|me a|up a) (?:message|note|email|dm)\b/.test(m) || /draft/.test(String(intent ?? ""))) out.push(CONTRACTS.draft);
  if (/\bwhat (?:do i|would i|will i) need\b|\bwhat(?:'s| is) (?:needed|required)\b|\brequirements?\b|\bwhat do you need\b/.test(m)) out.push(CONTRACTS.requirements);
  return out;
}
export const contractBlock = (cs: Contract[]) => cs.length ? `THIS REPLY MUST: ${cs.map((c) => c.says).join(" ")}` : "";

// ------------------------------------------------------------------------------------------------ repair + fallback
export type RepairModel = (o: { system: string; user: string }) => Promise<string>;
export const REPAIR_SYSTEM = "You fix a text message from a career assistant. You get only the sentences that failed code's checks, each with code's reason, " +
  "and the evidence units they may cite. Return the fixed sentences only, one per line, each tagged with the ids it rests on ([E3]); leave out a sentence you cannot " +
  "support from these units. If a length limit is given, the whole reply must fit it. If something the reply must contain is missing, add one sentence for it. No other text.";
export interface PipelineOut { text: string; repaired: boolean; dropped: Failure[]; calls: number; fallback: boolean }
export async function runReplyPipeline(draft: string, ledger: Ledger, o: { judge?: SupportJudge | null; repair?: RepairModel | null; own?: string[]; onRecord?: (s: string) => boolean | null;
  ask: string; contracts?: Contract[]; maxChars?: number; answers?: (text: string) => boolean; names?: string[] }): Promise<PipelineOut> {
  const v1 = await verifyTagged(draft, ledger, o);
  const len = (t: string) => t.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().length;
  const contractMiss = (t: string) => (o.contracts ?? []).map((c) => c.missing(t, o.ask)).filter(Boolean) as string[];
  const tooLong = o.maxChars && len(v1.text) > o.maxChars ? `the reply is ${len(v1.text)} characters; the limit is ${o.maxChars}` : null;
  const miss = contractMiss(v1.text);
  let text = v1.text, calls = 0, repaired = false, dropped = v1.failures, cites = [...v1.cites];
  if ((v1.failures.length || tooLong || miss.length) && o.repair) {
    const user = [v1.failures.length ? `FAILED SENTENCES:\n${v1.failures.map((f) => `- ${f.sentence} (code: ${f.reason})`).join("\n")}` : "",
      tooLong ? `LENGTH: ${tooLong}. The sentences that stood:\n${v1.text}` : "", miss.length ? `MISSING: ${miss.join("; ")}.` : "",
      `EVIDENCE:\n${ledger.block()}`].filter(Boolean).join("\n\n");
    calls = 1;
    const out = await o.repair({ system: REPAIR_SYSTEM, user }).catch(() => "");
    if (out.trim()) {
      const v2 = await verifyTagged(out, ledger, o);
      // The repaired sentences join what stood (or, for a length repair, replace it when shorter and every figure it keeps is checked).
      // (a repaired opening sentence opens the reply again: the answer comes first)
      const firstFailed = v1.failures.length && tagsOf(splitSentences(String(draft).split("\n")[0] ?? "")[0] ?? "").text === v1.failures[0].sentence;
      const joined = tooLong && v2.text && len(v2.text) < len(text) ? v2.text : (firstFailed ? [v2.text, text] : [text, v2.text]).filter(Boolean).join(" ");
      if (!o.maxChars || len(joined) <= o.maxChars || len(joined) <= len(text)) { text = joined; repaired = true; cites = [...new Set([...cites, ...v2.cites])]; }
      dropped = v2.failures;
    }
  }
  if (o.maxChars && len(text) > o.maxChars) {
    // Still over: whole sentences from the end go (never a cut mid-sentence; never the first, which answers).
    const ss = splitSentences(text.replace(/\n+/g, " "));
    while (ss.length > 1 && len(ss.join(" ")) > o.maxChars) ss.pop();
    text = ss.join(" ");
  }
  // (a page's own source numbers, "[1]", mean nothing on this path: the units carry their links)
  text = text.replace(/\s*\[\d+\](?:\s*\[\d+\])*/g, "").split("\n").filter((l) => !/^\s*[.,;:]?\s*$/.test(l) || !l.trim()).join("\n").trim();
  const answers = o.answers ?? ((t: string) => splitSentences(t).some((s) => /\p{L}/u.test(s.replace(/https?:\/\/\S+/g, "")) && !noClaim(s) && !/\?\s*$/.test(s)));
  let fallback = false;
  if (!answers(text)) { text = [text, fallbackLine(ledger, o.ask, o.names)].filter(Boolean).join("\n\n"); fallback = true; }
  // Live-12 review (item 3; D-024, D-060): the tags go, the sources stay: each kept sentence's cited unit's link, on its own line, once.
  const links = [...new Set(cites.map((id) => ledger.get(id)?.url).filter((u): u is string => !!u))].filter((u) => !text.includes(u));
  if (links.length && !fallback) text = `${text}\n${links.join("\n")}`;
  return { text: stripTags(text).trim(), repaired, dropped, calls, fallback };
}
// What could not be verified, and what the ledger does hold for what was asked, with its link. Live-12 review (item 8, D73-6): the ask's
// names (an employer, a place: the words of the ask that are names in this conversation, `names`, or in the ledger) must ALL be in the
// unit: a Citadel ask never gets another employer's pay, and an ask that names no one gets nothing listed.
export function fallbackLine(ledger: Ledger, ask: string, names: string[] = []): string {
  const known = new Set([...names, ...ledger.units.flatMap((u) => u.text.match(/(?<![\p{L}])\p{Lu}[\p{L}&'-]{2,}/gu) ?? [])].map((w) => w.toLowerCase().replace(/'s$/, "")));
  const asked = [...new Set((String(ask ?? "").toLowerCase().match(/\p{L}[\p{L}&'-]{1,}/gu) ?? []).map((w) => w.replace(/'s$/, "")))].filter((w) => known.has(w) && !/^(?:i|the|and|pay|what|how|for|with|is|are|my|your)$/.test(w));
  const held = !asked.length ? [] : ledger.units.filter((u) => u.kind === "chat" && /\d/.test(u.text) && asked.every((w) => nameFoundIn(w, u.text)));
  return [`I couldn't verify an answer to that from what I read.${held.length ? " This chat's tool results do hold:" : ""}`, ...held.slice(0, 3).map((u) => `${u.text}${u.url ? `\n${u.url}` : ""}`)].join("\n");
}
