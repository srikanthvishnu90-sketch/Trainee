// DT-1: the mass-apply OUTCOME eval. For a fixed set of real captured application forms (Greenhouse, Lever, Ashby; read
// from the committed question sets, never fetched) and two synthetic people, each application is driven through the
// product's own pure functions, offline, and graded on what happened to it, never on wording:
//   prepare   planForm (extension/src/apply_core.ts, the planner the extension and the browser worker use): every field
//             graded against hand labels (gold.json) written from each field's meaning and the person's confirmed facts
//   approve   cardTurn (career_apply_cards.ts) over an in-memory card store that does what career_apply_card_answer_as
//             does; the card grammar decides which numbers are approved; hashApplyPayload binds each item
//   enqueue   admitApplication (career_apply.ts, the TS mirror of the ledger): approval hash = payload hash, exact
//             duplicates (D-MS-3) refused by URL variants of the same posting, a second role at one company admitted
//   submit    classifyOutcome / outcomeAfterSend over simulated employer pages (scenarios.json), recorded as the finish
//             function records them, and whether a second send is refused
//   proof     receiptText says only what is true; planConfirmations confirms only by the employer's authenticated email
// Deterministic: a pinned clock, no network, no model, no randomness. The optional judge (judge.ts, off by default) is the
// only part that calls a model, and only through the `claude` CLI on the owner's subscription.
import { planForm } from "../../../extension/src/apply_core.ts";
import { admitApplication, classifyOutcome, type LogRow, normLabel, outcomeAfterSend } from "../../../supabase/functions/_shared/career_apply.ts";
import { CARD_INTENT, type CardStore, cardTurn, cardWaiting, type Prepared } from "../../../supabase/functions/_shared/career_apply_cards.ts";
import { hashApplyPayload } from "../../../supabase/functions/_shared/career_apply_store.ts";
import { receiptText } from "../../../supabase/functions/_shared/career_apply_receipts.ts";
import { planConfirmations } from "../../../supabase/functions/_shared/career_apply_confirm.ts";
import { mapQuestion } from "../../../supabase/functions/_shared/question_map.ts";
import { postingLocation } from "../../apply/fill-coverage.ts";

export const HERE = new URL("./", import.meta.url);
export const ROOT = new URL("../../../", import.meta.url);
const readJson = (u: URL) => JSON.parse(Deno.readTextFileSync(u));

export type Family = "greenhouse" | "lever" | "ashby";
export interface Field { name: string; label: string; required: boolean; type: string; options: { label: string; value: string }[] }
export interface Posting { id: string; family: Family; company: string; source_url: string; location?: string; fields: Field[] }
export interface Persona { name: string; resume_sha256: string; confirmed: Record<string, string> }
export type Expect = { kind: "fill" | "either" | "ask" | "alt"; accept: string[]; ko: boolean; contested: boolean; note?: string };
export type FieldVerdict =
  | "correct_fill" | "wrong" | "contested_fill" | "unverifiable_fill" | "unneeded_ask" | "correct_ask" | "correct_empty"
  | "missed_optional" | "missed_required" | "silent_gap" | "alt";

// ------------------------------------------------------------------------------------------------ inputs
export function loadInputs() {
  const gold = readJson(new URL("gold.json", HERE));
  const personas: Record<string, Persona> = readJson(new URL("personas.json", HERE)).personas;
  const scenarios = readJson(new URL("scenarios.json", HERE));
  const sets = new Map<string, any>();
  const postings: { posting: Posting; labels: Record<string, unknown> }[] = gold.postings.map((g: any) => {
    if (!sets.has(g.set)) sets.set(g.set, readJson(new URL(g.set, ROOT)));
    const p = sets.get(g.set).postings.find((x: any) => x.id === g.id);
    if (!p) throw new Error(`gold names ${g.id}, which is not in ${g.set}`);
    const posting: Posting = {
      id: p.id, family: p.family, company: p.company, source_url: p.source_url, location: postingLocation(p),
      fields: p.fields.map((f: any) => ({ name: String(f.name), label: String(f.label), required: !!f.required, type: String(f.type),
        options: (f.options || []).map((o: any) => ({ label: String(o.label), value: String(o.value ?? o.label) })) })),
    };
    return { posting, labels: g.fields };
  });
  return { gold, personas, scenarios, postings };
}

// ------------------------------------------------------------------------------------------------ gold
export function expectFor(spec: unknown, persona: string): Expect {
  const s: any = typeof spec === "string" ? { e: spec } : spec;
  const raw: string | undefined = s?.[persona] ?? s?.e;
  if (typeof raw !== "string") throw new Error(`no expectation for persona ${persona}: ${JSON.stringify(spec)}`);
  const [kind, rest = ""] = raw.split(/:(.*)/s);
  if (!["fill", "either", "ask", "alt"].includes(kind)) throw new Error(`bad expectation ${raw}`);
  return { kind: kind as Expect["kind"], accept: rest ? rest.split("|") : [], ko: !!s.ko, contested: !!s.contested, ...(s.note ? { note: s.note } : {}) };
}

export const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
const BOOL_YES = new Set(["yes", "true", "on", "checked", "1", "y"]);
const BOOL_NO = new Set(["no", "false", "off", "unchecked", "0", "n", ""]);
const boolOf = (v: unknown) => BOOL_YES.has(norm(v)) ? "yes" : BOOL_NO.has(norm(v)) ? "no" : null;
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

// One accepted value, resolved for this person: `$fact` is their confirmed value (an unconfirmed fact is a gold error),
// `@resume` their resume.
export function resolveAccept(a: string, p: Persona): string {
  if (a === "@resume") return "@resume";
  if (a.startsWith("$")) {
    const v = p.confirmed[a.slice(1)];
    if (v === undefined) throw new Error(`gold uses ${a}, which ${p.name} has not confirmed`);
    return v;
  }
  return a;
}

// What a planned value says, in the form's own terms: the option label it picks (null when several options share that
// value, so the payload does not say which one was chosen), a yes/no for a box, the resume, or the text.
export function shownValue(f: Field, value: string, p: Persona): { text: string | null; unverifiable: boolean } {
  if (value === p.resume_sha256 || (/^[0-9a-f]{40,64}$/.test(value) && p.resume_sha256.startsWith(value))) return { text: "@resume", unverifiable: false };
  if (f.options.length) {
    const hits = [...new Set(f.options.filter((o) => o.value === value).map((o) => o.label))];
    if (hits.length > 1) return { text: null, unverifiable: true };
    if (hits.length === 1) return { text: hits[0], unverifiable: false };
    const byLabel = f.options.find((o) => norm(o.label) === norm(value));
    if (byLabel) return { text: byLabel.label, unverifiable: false };
    // A multi-select answer ("English, Hindi" or "id1,id2"): each part as its option label.
    const parts = value.split(/\s*[,;|]\s*/).filter(Boolean);
    if (parts.length > 1) {
      const labels = parts.map((x) => f.options.find((o) => o.value === x)?.label ?? f.options.find((o) => norm(o.label) === norm(x))?.label ?? x);
      return { text: labels.join(", "), unverifiable: false };
    }
    return { text: value, unverifiable: false };
  }
  return { text: value, unverifiable: false };
}

export function accepts(f: Field, shown: string, accept: string[], p: Persona): boolean {
  const box = f.type === "checkbox" && !f.options.length;
  // A multi-select answer is right when every part it picks is an accepted value (and it is not one option's own label).
  if (f.options.length && !f.options.some((o) => norm(o.label) === norm(shown)) && /[,;|]/.test(shown)) {
    const parts = shown.split(/\s*[,;|]\s*/).filter(Boolean);
    if (parts.length > 1) return parts.every((x) => accepts(f, x, accept, p));
  }
  for (const raw of accept) {
    if (raw === "*") return true;
    const a = resolveAccept(raw, p);
    if (a === "@resume" || shown === "@resume") { if (a === shown) return true; continue; }
    if (box) { if (boolOf(shown) !== null && boolOf(shown) === boolOf(a)) return true; continue; }
    if (a.endsWith("*")) { if (norm(shown).startsWith(norm(a.slice(0, -1)))) return true; continue; }
    if (norm(shown) === norm(a)) return true;
    // A phone number: the same ten-digit national number, with or without its country code.
    if (digits(a).length >= 10 && digits(shown).length >= 10 && digits(a).slice(-10) === digits(shown).slice(-10) && !/[a-z]/i.test(shown)) return true;
  }
  return false;
}

// Gold that cannot be checked is a gold error, never a silent pass: every accepted option must exist on the form.
export function validateGold(postings: { posting: Posting; labels: Record<string, unknown> }[], personas: Record<string, Persona>): string[] {
  const errors: string[] = [];
  for (const { posting, labels } of postings) {
    const idx = Object.keys(labels).map(Number);
    for (let i = 0; i < posting.fields.length; i++) if (!idx.includes(i)) errors.push(`${posting.id}: field ${i} "${posting.fields[i].label.slice(0, 50)}" has no label`);
    for (const i of idx) {
      const f = posting.fields[i];
      if (!f) { errors.push(`${posting.id}: label for field ${i}, which does not exist`); continue; }
      for (const k of Object.keys(personas)) {
        let e: Expect;
        try { e = expectFor(labels[String(i)], k); } catch (err) { errors.push(`${posting.id}#${i}: ${(err as Error).message}`); continue; }
        for (const raw of e.accept) {
          let a: string;
          try { a = resolveAccept(raw, personas[k]); } catch (err) { errors.push(`${posting.id}#${i} ${k}: ${(err as Error).message}`); continue; }
          if (raw === "*" || !f.options.length) continue;
          const ok = f.options.some((o) => a.endsWith("*") ? norm(o.label).startsWith(norm(a.slice(0, -1))) : norm(o.label) === norm(a));
          if (!ok && e.kind === "fill") errors.push(`${posting.id}#${i} ${k}: "${a}" is not an option of "${f.label.slice(0, 50)}"`);
        }
      }
    }
  }
  return errors;
}

// ------------------------------------------------------------------------------------------------ stage 1: prepare
export function factsOf(p: Persona, tag: string) {
  return Object.fromEntries(Object.entries(p.confirmed).map(([fact, v]) => [fact, { value: v === "@resume" ? p.resume_sha256 : v, factId: `${tag}:${fact}` }]));
}

export interface FieldResult { i: number; name: string; label: string; required: boolean; expect: Expect; verdict: FieldVerdict; value?: string; shown?: string | null; fact?: string; product_fact: string }

export function prepare(posting: Posting, labels: Record<string, unknown>, persona: Persona, tag: string, now: number) {
  const plan = planForm({ userId: `TEST-${tag}`, jobId: posting.id, company: posting.company, family: posting.family as any, schema: posting.fields as any,
    answers: factsOf(persona, tag), saved: {}, now, location: posting.location });
  // A planned value belongs to the first field of that name not yet given one (the planner walks fields in order).
  const fillOf = new Map<number, { value: string; factId: string }>();
  for (const x of plan.fill) {
    const i = posting.fields.findIndex((f, j) => f.name === x.name && !fillOf.has(j));
    if (i >= 0) fillOf.set(i, { value: x.value, factId: x.factId });
  }
  // An open question belongs to the first required field with its wording not yet asked.
  const askedOf = new Set<number>();
  for (const n of plan.needs) {
    const i = posting.fields.findIndex((f, j) => !askedOf.has(j) && !fillOf.has(j) && norm(f.label) === norm(n.label));
    if (i >= 0) askedOf.add(i);
  }
  for (const x of [...plan.identity, ...plan.ambiguous]) {
    const i = posting.fields.findIndex((f, j) => f.name === x.name && !askedOf.has(j) && !fillOf.has(j));
    if (i >= 0) askedOf.add(i);
  }
  const fields: FieldResult[] = posting.fields.map((f, i) => {
    const expect = expectFor(labels[String(i)], tag);
    const product_fact = mapQuestion(f).fact;
    const base = { i, name: f.name, label: f.label, required: f.required, expect, product_fact };
    if (expect.kind === "alt") return { ...base, verdict: "alt" as const };
    const fill = fillOf.get(i);
    if (fill) {
      const shown = shownValue(f, fill.value, persona);
      const fact = fill.factId.split(":")[1];
      const ok = expect.kind !== "ask" && shown.text !== null && accepts(f, shown.text, expect.accept, persona);
      const verdict: FieldVerdict = shown.unverifiable ? "unverifiable_fill" : ok ? "correct_fill" : expect.contested ? "contested_fill" : "wrong";
      return { ...base, verdict, value: fill.value, shown: shown.text, fact };
    }
    if (askedOf.has(i)) return { ...base, verdict: (expect.kind === "fill" ? "unneeded_ask" : "correct_ask") as FieldVerdict };
    if (f.required) return { ...base, verdict: (expect.kind === "fill" ? "missed_required" : "silent_gap") as FieldVerdict };
    return { ...base, verdict: (expect.kind === "fill" ? "missed_optional" : "correct_empty") as FieldVerdict };
  });
  const plannerReady = !plan.needs.length && !plan.identity.some((x) => x.required) && !plan.ambiguous.some((x) => x.required);
  // Ready is right only when no required question lacks a confirmed answer; held is right only when at least one of the
  // questions holding it is genuinely unanswerable (an `either` the planner chose to ask counts as genuine).
  const goldReady = fields.every((r) => !r.required || r.expect.kind !== "ask");
  const holding = fields.filter((r) => r.required && (r.verdict === "correct_ask" || r.verdict === "unneeded_ask"));
  const state = plannerReady ? (goldReady ? "ready" : "unsafe_ready")
    : holding.some((r) => r.verdict === "correct_ask") ? "held" : "over_held";
  return { plan, fields, plannerReady, goldReady, state };
}

// The person answers every open question once (as on the ask-once panel), so the rest of the journey runs for every
// application: the first real option, a yes for a box, a link for a link field, a number for pay, else a TEST answer.
// These answers are the person's own, saved under the question's wording; they are never graded as the planner's.
export function personAnswers(posting: Posting, needs: { label: string }[], tag: string) {
  const saved: Record<string, { value: string; factId: string }> = {};
  for (const n of needs) {
    const f = posting.fields.find((x) => norm(x.label) === norm(n.label));
    if (!f) continue;
    const opts = f.options.filter((o) => o.label && !/^select\b/i.test(o.label.trim()));
    const value = opts.length ? opts[opts.length > 1 && /^(yes|no)$/i.test(opts[1].label) ? 1 : 0].label
      : f.type === "checkbox" ? "Yes"
      : /url|link|portfolio|website|github|linkedin|exercise/i.test(f.label) || f.type === "url" ? "https://example.test/TEST"
      : /salary|compensation|pay\b|\$/i.test(f.label) ? "95000"
      : "TEST answer";
    saved[normLabel(f.label)] = { value, factId: `${tag}:answered` };
  }
  return saved;
}

// ------------------------------------------------------------------------------------------------ stage 2: the card
// The database's card half, in memory: what career_apply_card_open_for / career_apply_card_answer_as do (one open card, an
// item whose prepared payload no longer hashes to what the card carries is 'changed', answered once). The product decides
// which numbers a reply approves (cardTurn); this store only holds rows.
export function cardDb(rows: { id: string; company: string; card_lines: string[]; resume_sha256: string; hash: string }[], now: number) {
  const prepared = rows.map((r) => ({ ...r, state: "ready" }));
  const cards: { id: string; items: { n: number; prepared_id: string; payload_hash: string }[]; shown_at: string; state: string; closed?: boolean }[] = [];
  const queue: { prepared_id: string; approval: string }[] = [];
  const answerCalls: number[][] = [];
  let seq = 0, lastIntent: string | null = null, lastCard: string | null = null;
  const store: CardStore = {
    pending: async () => prepared.filter((p) => ["ready", "shown"].includes(p.state)).map(({ id, company, card_lines, resume_sha256 }): Prepared => ({ id, company, card_lines, resume_sha256 })),
    open: async (_u, ids) => {
      if (!ids.length) throw new Error("open a card: invalid card");
      for (const c of cards) if (c.state === "open") { c.state = "answered"; c.closed = true; }
      const card = { id: `C${++seq}`, items: ids.map((id, i) => ({ n: i + 1, prepared_id: id, payload_hash: prepared.find((p) => p.id === id)!.hash })), shown_at: new Date(now).toISOString(), state: "open" };
      for (const id of ids) prepared.find((p) => p.id === id)!.state = "shown";
      cards.push(card);
      return card;
    },
    latestOpen: async () => cards.filter((c) => c.state === "open").at(-1) ?? null,
    answer: async (_u, cardId, approve) => {
      answerCalls.push([...approve]);
      const c = cards.find((x) => x.id === cardId)!;
      if (c.state !== "open") throw new Error("answer the card: card_answered");
      const out = c.items.map((it) => {
        const p = prepared.find((x) => x.id === it.prepared_id)!;
        let result: string;
        if (p.hash !== it.payload_hash) result = "changed";
        else if (approve.includes(it.n)) { queue.push({ prepared_id: p.id, approval: it.payload_hash }); result = "queued"; }
        else result = "declined";
        p.state = result === "queued" ? "approved" : "declined";
        return { n: it.n, company: p.company, result };
      });
      c.state = "answered";
      return out;
    },
    lastAssistantIntent: async () => lastIntent,
    lastShownCard: async () => (lastIntent === CARD_INTENT ? lastCard : null),
    cardState: async (_u, id) => {
      const c = cards.find((x) => x.id === id);
      return !c ? null : c.state === "open" ? "open" : c.closed ? "closed" : "answered";
    },
  };
  const say = async (message: string) => {
    const r = await cardTurn({ message, userId: "TEST", threadId: "TH", now, store, resumeReady: async () => true });
    if (r) {
      const waiting = cardWaiting(r);
      lastIntent = waiting ? CARD_INTENT : "career_apply_card_answer";
      if (waiting && r.card_id) lastCard = r.card_id;
    } else lastIntent = "agent";
    return r;
  };
  return { store, say, queue, answerCalls, prepared, cards };
}

// ------------------------------------------------------------------------------------------------ stage 4: submit
export function observation(o: any, url: string) {
  return {
    url_before: url, url_after: o.url_changed ? url + "/thanks" : url, form_present_after: !!o.form_present_after,
    required_empty_after: 0, validation_errors: o.validation_errors ?? [], captcha: !!o.captcha, email_code_prompt: !!o.email_code_prompt,
    page_text: o.page_text ?? "",
  };
}
// How the finish function records an engine outcome (20261021075000_career_apply_ops.sql, career_apply_finish): a page's own
// "thank you" is evidence, never confirmation; the row waits as submitted_unconfirmed for the employer's email.
export function recordFinish(engine: { state: string; reason: string; confirmation_id: string | null }) {
  const page = engine.state === "confirmed";
  return { state: page ? "submitted_unconfirmed" : engine.state, reason: engine.reason, confirmation_id: engine.confirmation_id, evidence: page ? { page_confirmation: true } : null };
}

const boardOf = (url: string) => /^https?:\/\/[^/]+\/([^/?#]+)/.exec(url)?.[1] ?? "";
export function variantsOf(p: Posting, templates: { id: string; url: string }[]): { id: string; url: string }[] {
  const board = boardOf(p.source_url);
  const jid = p.family === "greenhouse" ? /\/jobs\/(\d+)/.exec(p.source_url)?.[1] ?? "" : /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(p.source_url)?.[0] ?? "";
  return templates.map((t) => ({ id: t.id, url: t.url.replace("{board}", board).replace("{jid}", jid) }));
}
export function otherRoleUrl(p: Posting): string {
  return p.family === "greenhouse" ? p.source_url.replace(/\/jobs\/(\d+)/, (_m, d) => `/jobs/${String(BigInt(d) + 1n)}`)
    : p.source_url.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, "00000000-0000-4000-8000-000000000001");
}

// ------------------------------------------------------------------------------------------------ the run
export interface Failure { stage: string; cls: string; app: string; detail: string }

export async function runAll(o: { only?: string[] } = {}) {
  const { personas, scenarios, postings } = loadInputs();
  const gold_errors = validateGold(postings, personas);
  if (gold_errors.length) throw new Error("gold.json is inconsistent:\n" + gold_errors.join("\n"));
  const now = Date.parse(scenarios.now);
  const apps: any[] = [];
  const failures: Failure[] = [];
  for (const tag of Object.keys(personas).sort()) {
    const persona = personas[tag];
    const userId = `TEST-${tag}`;
    // ---- prepare every posting
    const prepared: any[] = [];
    for (const { posting, labels } of postings) {
      if (o.only && !o.only.includes(posting.family)) continue;
      const key = `${tag}/${posting.id}`;
      const r = prepare(posting, labels, persona, tag, now);
      const app: any = { key, persona: tag, posting: posting.id, family: posting.family, company: posting.company, prepared_state: r.state,
        fields: r.fields.filter((f) => f.verdict !== "alt").map((f) => ({ i: f.i, label: f.label.slice(0, 120), required: f.required, expect: `${f.expect.kind}${f.expect.accept.length ? ":" + f.expect.accept.join("|") : ""}`,
          ko: f.expect.ko, verdict: f.verdict, ...(f.shown !== undefined ? { shown: f.shown === null ? null : String(f.shown).slice(0, 80) } : {}), ...(f.fact ? { fact: f.fact } : {}), product_fact: f.product_fact })),
        checks: {} as Record<string, boolean | null> };
      for (const f of r.fields) {
        const where = `${key}#${f.i}`;
        const what = `"${f.label.slice(0, 70)}"`;
        if (f.verdict === "wrong") failures.push({ stage: "prepare", cls: `wrong answer: ${f.fact} put on a ${f.expect.ko ? "knockout " : ""}${f.expect.kind === "ask" ? "question no confirmed fact answers" : "question it answers wrongly"}`, app: where, detail: `${what} got "${String(f.shown).slice(0, 60)}"; gold ${f.expect.kind}:${f.expect.accept.join("|")}` });
        if (f.verdict === "unverifiable_fill") failures.push({ stage: "prepare", cls: "unidentifiable answer: the prepared payload records a value every option shares (Ashby radio \"on\"), so the approved payload does not say which option", app: where, detail: `${what} value "${f.value}" (${f.fact})` });
        if (f.verdict === "unneeded_ask") failures.push({ stage: "prepare", cls: `asked though a confirmed fact answers it: ${f.product_fact}`, app: where, detail: what });
        if (f.verdict === "missed_optional") failures.push({ stage: "prepare", cls: `optional field left empty though a confirmed fact answers it: ${f.product_fact}`, app: where, detail: what });
        if (f.verdict === "missed_required") failures.push({ stage: "prepare", cls: "required field neither filled nor asked (answerable)", app: where, detail: what });
        if (f.verdict === "silent_gap") failures.push({ stage: "prepare", cls: "required field neither filled nor asked (unanswerable)", app: where, detail: what });
      }
      if (r.state === "unsafe_ready") failures.push({ stage: "prepare", cls: "marked ready to approve while a required question has no confirmed answer", app: key, detail: "" });
      if (r.state === "over_held") failures.push({ stage: "prepare", cls: "held for questions though every required field is answerable from confirmed facts", app: key, detail: "" });
      app.checks.prepared_state = r.state === "ready" || r.state === "held";
      apps.push(app);
      if (r.plannerReady) { prepared.push({ app, posting, fill: r.plan.fill }); app.after_answers = "ready"; continue; }
      // Held: the person answers its questions once, and it is prepared again.
      const saved = personAnswers(posting, r.plan.needs, tag);
      const again = planForm({ userId: userId, jobId: posting.id, company: posting.company, family: posting.family as any, schema: posting.fields as any,
        answers: factsOf(persona, tag), saved, now, location: posting.location });
      const readyNow = !again.needs.length && !again.identity.some((x) => x.required) && !again.ambiguous.some((x) => x.required);
      app.after_answers = readyNow ? "ready" : `still held: ${again.needs.map((n) => n.label.slice(0, 40)).concat(again.identity.filter((x) => x.required).map((x) => `identity ${x.label.slice(0, 30)}`), again.ambiguous.filter((x) => x.required).map((x) => `ambiguous ${x.label.slice(0, 30)}`)).join("; ")}`;
      app.checks.preparable_after_answers = readyNow;
      if (!readyNow) failures.push({ stage: "prepare", cls: again.identity.some((x) => x.required)
        ? "never preparable by text: a required question the person can answer (a link) is treated as a never-by-text identity or secret field"
        : "still held after the person answered every question", app: key, detail: app.after_answers.slice(0, 160) });
      if (readyNow) prepared.push({ app, posting, fill: again.fill });
    }
    // ---- the card and the one yes
    const rows = [];
    for (const x of prepared) {
      const payload = { version: 1, user_id: userId, job_id: x.posting.id, company: x.posting.company, url: x.posting.source_url, family: x.posting.family,
        fields: x.fill.map((f: any) => ({ name: f.name, value: f.value, factId: f.factId })), resume_sha256: persona.resume_sha256,
        privacy_epoch: 1, account_version: 1, expires_at: new Date(now + 86400000).toISOString() };
      x.payload = payload;
      x.hash = await hashApplyPayload(payload);
      rows.push({ id: x.posting.id, company: x.posting.company, resume_sha256: persona.resume_sha256, hash: x.hash,
        card_lines: [`${x.posting.company}`, ...x.fill.slice(0, 6).map((f: any) => `${f.label.slice(0, 40)}: ${String(f.value).slice(0, 40)}`), `Sends to ${x.posting.source_url}`] });
    }
    const db = cardDb(rows, now);
    const script: any[] = scenarios.card[tag] ?? [];
    let shown: { n: number; prepared_id: string; payload_hash: string }[] = [];
    const changed = new Set<string>();
    const card_log: any[] = [];
    for (const step of script) {
      if (step.mutate !== undefined) {
        const it = shown.find((s) => s.n === step.mutate);
        if (it) {
          const x = prepared.find((p) => p.posting.id === it.prepared_id)!;
          x.payload = { ...x.payload, fields: [...x.payload.fields, { name: "question_added_after_card", value: "TEST answer", factId: `${tag}:saved` }] };
          x.hash = await hashApplyPayload(x.payload);
          db.prepared.find((p) => p.id === it.prepared_id)!.hash = x.hash;
          changed.add(it.prepared_id);
        }
        card_log.push({ mutate: step.mutate, applied: !!it });
        continue;
      }
      const before = db.answerCalls.length;
      const r = await db.say(step.say);
      if (step.status === "shown" && db.cards.length) shown = db.cards.at(-1)!.items;
      const total = shown.length;
      let want: number[] | null = null;
      if (step.approves === "none") want = null;
      else if (step.approves === "all") want = shown.map((s) => s.n);
      else if (step.approves === "all_except") want = (step.except as number[]).some((n) => n > total) ? null : shown.map((s) => s.n).filter((n) => !step.except.includes(n));
      const call = db.answerCalls.length > before ? db.answerCalls.at(-1)! : null;
      // With nothing on the card there is nothing to approve: the product shows no card and approves nothing.
      const expectCall = total > 0 && want !== null && want.length > 0;
      const ok = expectCall ? JSON.stringify(call) === JSON.stringify(want) : call === null;
      card_log.push({ say: step.say, status: r?.status ?? null, approved: call, expected: expectCall ? want : null, ok });
      if (!ok) failures.push({ stage: "approve", cls: "a card reply approved a different set than the one the person named", app: `${tag}/card`, detail: `"${step.say}" approved ${JSON.stringify(call)}, expected ${JSON.stringify(expectCall ? want : null)}` });
    }
    // ---- enqueue (claim-time re-verify), duplicates
    const log: LogRow[] = [];
    const queuedIds = new Set(db.queue.map((q) => q.prepared_id));
    for (const x of prepared) {
      const it = shown.find((s) => s.prepared_id === x.posting.id);
      const approvedHere = queuedIds.has(x.posting.id);
      x.app.card = { n: it?.n ?? null, shown_hash: it?.payload_hash?.slice(0, 16) ?? null, changed: changed.has(x.posting.id), queued: approvedHere };
      if (changed.has(x.posting.id)) {
        x.app.checks.changed_not_queued = !approvedHere;
        if (approvedHere) failures.push({ stage: "approve", cls: "an item that changed after the card was shown was queued", app: x.app.key, detail: "" });
        // A stale approval presented at enqueue (the old hash against the new payload) must be refused.
        const stale = admitApplication(log, { user_id: userId, job_id: x.posting.id, company: x.posting.company, url: x.posting.source_url, approval_hash: it!.payload_hash, payload_hash: x.hash }, now);
        x.app.checks.stale_hash_refused = !stale.ok && stale.reason === "not_approved";
        if (!x.app.checks.stale_hash_refused) failures.push({ stage: "enqueue", cls: "an approval of an older payload was admitted", app: x.app.key, detail: JSON.stringify(stale) });
      }
      if (!approvedHere) continue;
      const q = db.queue.find((y) => y.prepared_id === x.posting.id)!;
      const admit = admitApplication(log, { user_id: userId, job_id: x.posting.id, company: x.posting.company, url: x.posting.source_url, approval_hash: q.approval, payload_hash: x.hash }, now);
      x.app.checks.hash_honoured = q.approval === it!.payload_hash && admit.ok;
      if (!x.app.checks.hash_honoured) failures.push({ stage: "enqueue", cls: "an approved application at its shown hash was not admitted", app: x.app.key, detail: JSON.stringify(admit) });
      if (!admit.ok) continue;
      log.push({ user_id: userId, job_id: x.posting.id, company: x.posting.company, url: x.posting.source_url, at: now, state: "queued" });
      const dupes = variantsOf(x.posting, scenarios.duplicates[x.posting.family]).map((v, k) =>
        ({ id: v.id, url: v.url, r: admitApplication(log, { user_id: userId, job_id: `${x.posting.id}#via${k}`, company: x.posting.company, url: v.url }, now) }));
      dupes.push({ id: "the same link and job id again", url: x.posting.source_url, r: admitApplication(log, { user_id: userId, job_id: x.posting.id, company: x.posting.company, url: x.posting.source_url }, now) });
      const other = admitApplication(log, { user_id: userId, job_id: `${x.posting.id}#other-role`, company: x.posting.company, url: otherRoleUrl(x.posting) }, now);
      x.app.duplicates = { probes: dupes.map((d) => ({ id: d.id, url: d.url, refused: !d.r.ok && d.r.reason === "duplicate_job" })), other_role_admitted: other.ok };
      x.app.checks.duplicates_refused = dupes.every((d) => !d.r.ok && d.r.reason === "duplicate_job");
      x.app.checks.other_role_admitted = other.ok;
      for (const d of dupes) if (d.r.ok || d.r.reason !== "duplicate_job") failures.push({ stage: "enqueue", cls: `a second application to the same ${x.posting.family} posting was admitted: ${d.id}`, app: x.app.key, detail: d.url });
      if (!other.ok) failures.push({ stage: "enqueue", cls: "a different role at the same company was refused (D-MS-3)", app: x.app.key, detail: JSON.stringify(other) });
      x.admitted = true;
    }
    // ---- submit against the simulated employer page, record, try to send again, say it
    const admitted = prepared.filter((x) => x.admitted);
    const portal: any[] = scenarios.portal;
    const rowsSent: any[] = [];
    admitted.forEach((x, k) => {
      const sc = portal[(k + (tag === "B" ? 3 : 0)) % portal.length];
      const obs = observation(sc.obs, x.posting.source_url);
      const engine = sc.posted ? outcomeAfterSend(obs) : classifyOutcome(obs);
      const row = recordFinish(engine);
      const stateOk = row.state === sc.state && (sc.reason === undefined || row.reason === sc.reason) && (!sc.page_confirmation || row.evidence?.page_confirmation === true);
      // The ledger now holds this row in its final state: a second send of the same posting is refused unless nothing reached the employer.
      const after: LogRow[] = log.map((l) => l.job_id === x.posting.id ? { ...l, state: row.state } : l);
      const again = admitApplication(after, { user_id: userId, job_id: `${x.posting.id}#retry`, company: x.posting.company, url: x.posting.source_url }, now);
      const resendOk = sc.resend === "refuse" ? !again.ok && again.reason === "duplicate_job" : again.ok;
      const text = receiptText({ company: x.posting.company, url: x.posting.source_url, ...row });
      const receiptOk = sc.receipt.must.every((re: string) => new RegExp(re, "i").test(text)) && !sc.receipt.must_not.some((re: string) => new RegExp(re, "i").test(text));
      x.app.submit = { portal: sc.id, posted: sc.posted, engine: engine.state, recorded: row.state, expected: sc.state, resend: again.ok ? "admitted" : again.reason, receipt: text };
      x.app.checks.submitted_state = stateOk;
      x.app.checks.resend_guard = resendOk;
      x.app.checks.receipt_truthful = receiptOk;
      if (!stateOk) failures.push({ stage: "submit", cls: `recorded state wrong after "${sc.id}"`, app: x.app.key, detail: `${row.state}/${row.reason}, expected ${sc.state}` });
      if (!resendOk) failures.push({ stage: "submit", cls: `second send ${sc.resend === "refuse" ? "admitted" : "refused"} after "${sc.id}"`, app: x.app.key, detail: JSON.stringify(again) });
      if (!receiptOk) failures.push({ stage: "proof", cls: `receipt says something untrue after "${sc.id}"`, app: x.app.key, detail: text.slice(0, 160) });
      if (sc.posted && ["submitted_unconfirmed", "unknown_outcome"].includes(row.state)) rowsSent.push({ x, row });
    });
    // ---- proof: the employer's authenticated email confirms exactly its application; a look-alike confirms nothing
    const ats: Record<Family, string> = { greenhouse: "us.greenhouse-mail.io", lever: "hire.lever.co", ashby: "ashbyhq.com" };
    const sentAt = new Date(now).toISOString();
    const queueRows = rowsSent.map(({ x, row }) => ({ id: x.posting.id, company: x.posting.company, url: x.posting.source_url, state: row.state, submitted_at: sentAt }));
    const mails: any[] = [];
    const expectConfirm = new Map<string, boolean>();
    const proofRows: { x: any; row: any; k: number }[] = [];
    for (const fam of ["greenhouse", "lever", "ashby"]) rowsSent.filter(({ x }) => x.posting.family === fam).slice(0, 2).forEach((r, k) => proofRows.push({ ...r, k }));
    proofRows.forEach(({ x, k }, j) => {
      const tpl = k === 0 ? scenarios.mail.authentic : scenarios.mail.lookalike;
      const slug = x.posting.company.toLowerCase().replace(/[^a-z0-9]/g, "");
      const fill = (s: string) => s.replaceAll("{Company}", x.posting.company).replaceAll("{domain}", ats[x.posting.family as Family]).replaceAll("{slug}", slug);
      const from = fill(tpl.from), domain = /@([^>\s]+)/.exec(from)![1].toLowerCase();
      mails.push({ hash: `mail-${tag}-${j}`, from, subject: fill(tpl.subject), snippet: fill(tpl.snippet), date: new Date(now + 3600000).toISOString(),
        auth: [`mx.google.com; dkim=pass header.i=@${domain} header.s=s1; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=REJECT) header.from=${domain}`] });
      expectConfirm.set(x.posting.id, k === 0);
    });
    const plans = planConfirmations(mails, queueRows);
    for (const { x, row } of proofRows) {
      const hit = plans.find((p) => p.kind === "confirm" && p.id === x.posting.id);
      const want = expectConfirm.get(x.posting.id)!;
      x.app.proof = { mail: want ? "authentic" : "lookalike", confirmed: !!hit };
      x.app.checks.proof = !!hit === want;
      if (!!hit !== want) failures.push({ stage: "proof", cls: want ? "the employer's own authenticated email did not confirm its application" : "a look-alike email confirmed an application", app: x.app.key, detail: mails[proofRows.findIndex((r) => r.x === x)]?.from ?? "" });
      if (hit) {
        const text = receiptText({ company: x.posting.company, url: x.posting.source_url, ...row, state: "confirmed", email_confirmed_at: hit.mail_at });
        x.app.proof.receipt = text;
        const claimOk = /confirmed by .*email/i.test(text);
        x.app.checks.proof_receipt = claimOk;
        if (!claimOk) failures.push({ stage: "proof", cls: "a confirmed application's receipt does not name its email proof", app: x.app.key, detail: text.slice(0, 160) });
      }
    }
    for (const p of plans) if (p.kind === "confirm" && !expectConfirm.has(p.id)) failures.push({ stage: "proof", cls: "an email confirmed an application it was not about", app: `${tag}/${p.id}`, detail: p.hash });
    apps.push({ key: `${tag}/card`, persona: tag, card: card_log, kind: "card" });
  }
  return { apps, failures };
}

// ------------------------------------------------------------------------------------------------ scorecard
const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : "n/a");
export function score(apps: any[], failures: Failure[]) {
  const groups: Record<string, any[]> = { greenhouse: [], lever: [], ashby: [] };
  for (const a of apps) if (a.kind !== "card") groups[a.family].push(a);
  const one = (list: any[]) => {
    const f = list.flatMap((a) => a.fields);
    const count = (v: string) => f.filter((x: any) => x.verdict === v).length;
    const expectedFills = f.filter((x: any) => x.expect.startsWith("fill")).length;
    const ko = f.filter((x: any) => x.ko);
    const asked = f.filter((x: any) => ["correct_ask", "unneeded_ask"].includes(x.verdict));
    const chk = (k: string) => { const v = list.map((a) => a.checks[k]).filter((x) => x !== undefined && x !== null); return { ok: v.filter(Boolean).length, of: v.length }; };
    const clean = list.filter((a) => !a.fields.some((x: any) => ["wrong", "unverifiable_fill", "silent_gap", "missed_required"].includes(x.verdict)) &&
      Object.values(a.checks).every((v) => v !== false));
    return {
      applications: list.length,
      applications_clean: clean.length,
      fields_graded: f.length,
      fills_expected: expectedFills,
      fills_correct: f.filter((x: any) => x.verdict === "correct_fill" && x.expect.startsWith("fill")).length,
      fills_correct_any: count("correct_fill"),
      wrong_answers: count("wrong"),
      unverifiable_answers: count("unverifiable_fill"),
      contested_fills: count("contested_fill"),
      questions_asked: asked.length,
      questions_genuinely_unanswerable: count("correct_ask"),
      questions_answerable_from_facts: count("unneeded_ask"),
      optional_missed: count("missed_optional"),
      required_silent_gaps: count("silent_gap") + count("missed_required"),
      knockout_fields: ko.length,
      knockout_correct: ko.filter((x: any) => ["correct_fill", "correct_ask", "correct_empty"].includes(x.verdict)).length,
      knockout_wrong: ko.filter((x: any) => x.verdict === "wrong").length,
      prepared_state: chk("prepared_state"),
      preparable_after_answers: list.filter((a) => a.after_answers === "ready").length,
      ready_for_card: list.filter((a) => a.prepared_state === "ready" || a.prepared_state === "unsafe_ready").length,
      unsafe_ready: list.filter((a) => a.prepared_state === "unsafe_ready").length,
      hash_honoured: chk("hash_honoured"),
      changed_not_queued: chk("changed_not_queued"),
      stale_hash_refused: chk("stale_hash_refused"),
      duplicates_refused: chk("duplicates_refused"),
      other_role_admitted: chk("other_role_admitted"),
      submitted_state: chk("submitted_state"),
      resend_guard: chk("resend_guard"),
      receipt_truthful: chk("receipt_truthful"),
      proof: chk("proof"),
      proof_receipt: chk("proof_receipt"),
    };
  };
  const by_family = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, one(v)]));
  const all = one(Object.values(groups).flat());
  const by_persona = Object.fromEntries(["A", "B"].map((p) => [p, one(apps.filter((a) => a.kind !== "card" && a.persona === p))]));
  const cards = apps.filter((a) => a.kind === "card").map((a) => ({ persona: a.persona, steps: a.card.length, ok: a.card.filter((s: any) => s.ok !== false).length }));
  const classes = new Map<string, { cls: string; stage: string; count: number; apps: Set<string>; example: string }>();
  for (const x of failures) {
    const e = classes.get(x.cls) ?? { cls: x.cls, stage: x.stage, count: 0, apps: new Set<string>(), example: `${x.app} ${x.detail}`.trim() };
    e.count++; e.apps.add(x.app.split("#")[0]); classes.set(x.cls, e);
  }
  const ranked = [...classes.values()].sort((a, b) => (b.stage === "prepare" && b.cls.startsWith("wrong") ? 1 : 0) - (a.stage === "prepare" && a.cls.startsWith("wrong") ? 1 : 0) || b.count - a.count || a.cls.localeCompare(b.cls))
    .map((e) => ({ cls: e.cls, stage: e.stage, count: e.count, applications: e.apps.size, example: e.example.slice(0, 220) }));
  const verdict = all.wrong_answers === 0 && all.unsafe_ready === 0 ? "PASS" : "FAIL";
  return { verdict, overall: all, by_family, by_persona, cards, failure_classes: ranked };
}

export function scorecardMd(s: any, meta: { trunk: string }) {
  const rows: [string, (x: any) => string][] = [
    ["Applications (postings x people)", (x) => `${x.applications}`],
    ["Applications fully clean (every check passed)", (x) => `${x.applications_clean} (${pct(x.applications_clean, x.applications)})`],
    ["Fields graded", (x) => `${x.fields_graded}`],
    ["Fields filled correctly from confirmed facts (of those gold says must be filled)", (x) => `${x.fills_correct}/${x.fills_expected} (${pct(x.fills_correct, x.fills_expected)})`],
    ["**Wrong answers (must be 0)**", (x) => `**${x.wrong_answers}**`],
    ["Answers the payload cannot identify (option values shared)", (x) => `${x.unverifiable_answers}`],
    ["Contested fills (second reading plausible; not counted wrong)", (x) => `${x.contested_fills}`],
    ["Questions left to ask the person", (x) => `${x.questions_asked}`],
    ["... genuinely unanswerable from confirmed facts", (x) => `${x.questions_genuinely_unanswerable}`],
    ["... answerable from confirmed facts (unneeded)", (x) => `${x.questions_answerable_from_facts}`],
    ["Optional fields left empty though a confirmed fact answers them", (x) => `${x.optional_missed}`],
    ["Required fields neither filled nor asked", (x) => `${x.required_silent_gaps}`],
    ["Screening / knockout fields handled correctly", (x) => `${x.knockout_correct}/${x.knockout_fields} (wrong: ${x.knockout_wrong})`],
    ["Prepared state correct (ready vs held for questions)", (x) => `${x.prepared_state.ok}/${x.prepared_state.of}`],
    ["Preparable once the person answers its questions (then on the card)", (x) => `${x.preparable_after_answers}/${x.applications}`],
    ["Ready for the card before any question (of which unsafe: ready with an unanswerable required field)", (x) => `${x.ready_for_card} (unsafe ${x.unsafe_ready})`],
    ["Payload hash approval honoured (queued at the shown hash, admitted)", (x) => `${x.hash_honoured.ok}/${x.hash_honoured.of}`],
    ["Changed after shown: not queued / stale approval refused", (x) => `${x.changed_not_queued.ok}/${x.changed_not_queued.of} / ${x.stale_hash_refused.ok}/${x.stale_hash_refused.of}`],
    ["Duplicates prevented (all link variants refused)", (x) => `${x.duplicates_refused.ok}/${x.duplicates_refused.of}`],
    ["Different role at the same company admitted", (x) => `${x.other_role_admitted.ok}/${x.other_role_admitted.of}`],
    ["Prepared-vs-submitted state recorded correctly", (x) => `${x.submitted_state.ok}/${x.submitted_state.of}`],
    ["Second send refused when anything may have reached the employer", (x) => `${x.resend_guard.ok}/${x.resend_guard.of}`],
    ["Receipts say only what is true", (x) => `${x.receipt_truthful.ok}/${x.receipt_truthful.of}`],
    ["Proof: confirmed only by the employer's authenticated email", (x) => `${x.proof.ok}/${x.proof.of}`],
    ["Confirmed receipts name their email proof", (x) => `${x.proof_receipt.ok}/${x.proof_receipt.of}`],
  ];
  const fams = ["greenhouse", "lever", "ashby"];
  const out = [
    "# Mass-apply outcome scorecard",
    "",
    `Generated by \`deno run --allow-read --allow-write evals/career/mass-apply-outcomes/run.ts --write\` (deterministic mode: no network, no model) on trunk \`${meta.trunk}\`. Do not edit by hand.`,
    "",
    `**Verdict: ${s.verdict}** (FAIL when any wrong answer or any application is marked ready with a required question no confirmed fact answers).`,
    "",
    `| Measure | ${fams.join(" | ")} | overall |`,
    `|---|${fams.map(() => "---").join("|")}|---|`,
    ...rows.map(([name, f]) => `| ${name} | ${fams.map((k) => f(s.by_family[k])).join(" | ")} | ${f(s.overall)} |`),
    "",
    "By person: " + Object.entries(s.by_persona).map(([k, x]: any) => `${k}: ${x.fills_correct}/${x.fills_expected} correct fills, ${x.wrong_answers} wrong, ${x.questions_asked} asked (${x.questions_answerable_from_facts} unneeded), ${x.ready_for_card} ready`).join("; ") + ".",
    "",
    "Card replies (approved exactly the set named): " + s.cards.map((c: any) => `${c.persona} ${c.ok}/${c.steps}`).join(", ") + ".",
    "",
    "## Failure classes (wrong answers first, then by count)",
    "",
    "| # | Stage | Class | Occurrences | Applications | Example |",
    "|---|---|---|---|---|---|",
    ...s.failure_classes.map((c: any, i: number) => `| ${i + 1} | ${c.stage} | ${c.cls.replace(/\|/g, "/")} | ${c.count} | ${c.applications} | ${c.example.replace(/\|/g, "/").replace(/\n/g, " ")} |`),
    "",
  ];
  return out.join("\n");
}
