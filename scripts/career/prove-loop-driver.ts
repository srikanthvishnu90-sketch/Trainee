// P0 proven loop, the Deno half (scripts/career/prove-loop.cjs runs it). One application, start to the submit click, on
// the product's own code and nothing written for the proof:
//   prepare (workers/career-browser/approve-first.ts, the engine's dry run through the cloud worker's own engine runner,
//   workers/career-cloud/worker.ts cloudEngineRunner) -> the questions it stopped on, asked once (ask-once.ts
//   questionsToStore) and answered from the TEST persona -> prepare again -> the card (supabase/functions/_shared/
//   career_apply_cards.ts cardTurn: "show my applications", then the person's tap on that card) -> the queued payload
//   is the one the card's hash names -> assertApprovedPayload (the cloud worker's own before-effects check) -> a fresh
//   page filled from the approved payload alone (factsFromPayload, as runCloudJob builds it) must give the engine the
//   same approval hash, field by field read back. Then it stops: no --submit is ever passed for a real employer.
// With fixtureSubmit (a local captured form whose own form posts to the local fixture server only), the approved job
// then goes through runCloudJob itself, so the receipt path is proven end to end against the fixture.
import { factsFromPayload, prepare, assertApprovedPayload, engineFacts, type RunEngine } from "../../workers/career-browser/approve-first.ts";
import { questionsToStore } from "../../workers/career-browser/ask-once.ts";
import { cloudEngineRunner, runCloudJob } from "../../workers/career-cloud/worker.ts";
import { answerText, CARD_INTENT, type CardStore, cardTurn } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { trustedManifest } from "../../extension/src/apply_core.ts";

const input = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const { url, factsPath, resumePath, workDir, extraArgs = [], answers = [], fixtureSubmit = false } = input;
const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const out: Record<string, any> = { steps: [] };
const step = (name: string, data: Record<string, unknown> = {}) => out.steps.push({ step: name, at: new Date().toISOString(), ...data });
const done = (extra: Record<string, unknown>) => {
  console.log("PROVE_LOOP " + JSON.stringify({ ...out, ...extra }));
  Deno.exit(0);
};

await Deno.mkdir(`${workDir}/evidence`, { recursive: true, mode: 0o700 });
await Deno.chmod(`${workDir}/evidence`, 0o700);
const cloud = cloudEngineRunner({ root, evidenceRoot: `${workDir}/evidence` });
// Every dry run the cloud runner makes, kept for the receipt (the runner reads the engine's evidence.json itself).
const runs: any[] = [];
const engine: RunEngine = async (args, env, controls) => {
  const r = await cloud([...args, ...extraArgs], env, controls);
  runs.push(r);
  return r;
};
const resumeBytes = await Deno.readFile(resumePath);
const resumeSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", resumeBytes))).map((n) => n.toString(16).padStart(2, "0")).join("");
const baseFacts = JSON.parse(await Deno.readTextFile(factsPath));
const account = { epoch: 1, version: 1 };

// 1. Prepare. A required question with no confirmed fact stops it (needs_answers): asked once, answered, prepared again.
let facts = engineFacts(baseFacts, []);
const write = async (f: unknown) => { await Deno.writeTextFile(`${workDir}/facts.json`, JSON.stringify(f), { mode: 0o600 }); return `${workDir}/facts.json`; };
let p = await prepare({ url, factsPath: await write(facts), resumePath, account, now: Date.now(), runEngine: engine });
step("prepare", { ready: p.ready, reason: p.ready ? "dry_run" : p.result?.reason });
if (!p.ready && p.result?.reason === "needs_answers") {
  const manifest = trustedManifest({ owner: facts.user_id, file: facts, rows: [], resume: { sha256: resumeSha } });
  const { questions } = questionsToStore(p.result, { facts: manifest.answers, answered: new Set() });
  const rows: { id: string; key: string; kind: string; answer: string }[] = [];
  const asked: any[] = [];
  for (const q of questions) {
    const a = answers.find((x: any) => new RegExp(x.match, "i").test(String(q.label)));
    const options = (q.options as string[]) || [];
    const fits = a && (!options.length || options.includes(a.answer));
    asked.push({ key: q.key, kind: q.kind, label: q.label, options: options.length, answered: !!fits, ...(a ? { answer: a.answer, from: a.from } : {}) });
    // A synthetic, deterministic row id per question: the persona's answer to it, as an answered career_apply_questions row.
    if (fits) rows.push({ id: `00000000-0000-4000-8000-${(await hashApplyPayload(q.key)).slice(0, 12)}`, key: String(q.key), kind: String(q.kind), answer: a.answer });
  }
  step("asked_once", { questions: asked });
  const unanswered = asked.filter((q) => !q.answered);
  if (unanswered.length) done({ outcome: "stopped_needs_answers", unanswered, runs });
  facts = engineFacts(baseFacts, rows);
  out.text_answers = rows;
  p = await prepare({ url, factsPath: await write(facts), resumePath, account, now: Date.now(), runEngine: engine });
  step("prepare_again", { ready: p.ready, reason: p.ready ? "dry_run" : p.result?.reason });
}
if (!p.ready) done({ outcome: "not_prepared", result: p.result, runs });
const ready = p as Extract<typeof p, { ready: true }>;
const prepared = runs.at(-1);

// 2. The card, shown through the same cardTurn the chat runs before any brain, and the person's tap on it. The store queues exactly what the
// card showed, by the payload hash the card carries (the database half is career_apply_card_answer_as).
const queue: any[] = [];
let card: any = null, last: string | null = null;
const store: CardStore = {
  pending: async () => [{ id: "PREPARED-1", company: ready.payload.company, card_lines: ready.card, resume_sha256: ready.payload.resume_sha256 }], // OWNER RULE: a card shows only an application that binds its resume
  open: async (_u, ids) => {
    card = { id: "CARD-" + (await hashApplyPayload([ids, ready.hash])).slice(0, 12), items: ids.map((id, i) => ({ n: i + 1, prepared_id: id, payload_hash: ready.hash })), shown_at: new Date().toISOString() };
    last = CARD_INTENT;
    return card;
  },
  latestOpen: async () => card,
  answer: async (_u, _c, approve) => card.items.map((it: any) => {
    if (approve.includes(it.n)) queue.push({ n: it.n, payload: ready.payload, payload_hash: it.payload_hash });
    return { n: it.n, company: ready.payload.company, result: approve.includes(it.n) ? "queued" : "declined" };
  }),
  lastAssistantIntent: async () => last,
};
const userId = ready.payload.user_id;
const shown = await cardTurn({ message: "show my applications", userId, threadId: "TEST-THREAD", now: Date.now(), store });
// The approval is the person's tap on the shown card (career_apply_card_answer_own), never a text yes: Option A (#162,
// 2026-10-22) and the bound text-yes rule (#165) both leave the tap as the one path that approves on its own.
const tapped = card ? await store.answer(userId, card.id, card.items.map((it: any) => it.n)) : [];
step("card", { shown: shown?.status, answered: "tap", card_id: card?.id });
out.card = { id: card?.id, text: shown?.reply, reply: answerText(tapped), tapped, items: card?.items };
if (queue.length !== 1) done({ outcome: "not_approved", runs });
const job = queue[0];

// 3. The approved payload is the one the card's hash names, the cloud worker's own check passes, and a fresh page filled
// from the approved payload alone gives the engine the same approval hash (the engine reads back every field it fills).
const payloadHash = await hashApplyPayload(job.payload);
if (payloadHash !== job.payload_hash || payloadHash !== ready.hash) done({ outcome: "APPROVED_APPLICATION_CHANGED", runs });
await assertApprovedPayload(job.payload, { url, user_id: userId });
const replay = await engine(["--url", url, "--facts", await write(factsFromPayload(job.payload)), "--resume", resumePath]);
const replayOk = replay?.result?.reason === "dry_run" && replay?.evidence?.approval_hash === job.payload.engine_approval;
step("verify_approved_equals_page", { engine_approval: job.payload.engine_approval, replay: replay?.evidence?.approval_hash ?? null, ok: replayOk });
if (!replayOk) done({ outcome: "APPROVED_APPLICATION_CHANGED", replay: replay?.result, runs });

// 4. Stop at the submit click, or (local fixture only) run the approved job through the cloud worker to the fixture.
let outcome = "stopped_before_submit", cloudRun: any = null;
if (fixtureSubmit) {
  const finished: any[] = [];
  const cloudQueue = {
    claim: async () => [], gatePresent: async () => true,
    authorize: async (j: any) => { if (await hashApplyPayload(j.payload) !== payloadHash) throw Error("APPROVED_APPLICATION_CHANGED"); },
    resume: async () => ({ filename: resumePath.split("/").pop()!, sha256: resumeSha, b64: btoa(String.fromCharCode(...resumeBytes)) }),
    ask: async () => 0,
    finish: async (_j: any, state: string, evidence: any, o: string) => { finished.push({ state, evidence, outcome: o }); },
  };
  await Deno.mkdir(`${workDir}/tmp`, { recursive: true });
  const r = await runCloudJob({ id: "TEST-FIXTURE-JOB", lease_token: "TEST-FIXTURE-LEASE", user_id: userId, company: job.payload.company, url, payload: job.payload,
    payload_hash: payloadHash, approval_hash: payloadHash, card_id: card.id, card_hash: payloadHash, execution_mode: "cloud" },
    { queue: cloudQueue, tmpRoot: `${workDir}/tmp`, log: () => {}, runEngine: (args, env, c) => engine([...args, "--state-dir", `${workDir}/state-submit`], env, c) });
  cloudRun = { ...r, finished: finished[0] ?? null };
  outcome = r.outcome === "submitted" ? "fixture_submitted" : `fixture_not_submitted:${r.reason}`;
  // The engine's own record of that submit run: where its one request went (keys only), what the route stopped.
  const ev = runs.at(-1)?.evidence || {};
  out.submit_run = { result: runs.at(-1)?.result ?? null, post: ev.post ?? null, request_shape: ev.request_shape ?? null,
    stopped_requests: ev.stopped_requests ?? [], transport_rejection: ev.transport_rejection ?? null };
  step("fixture_submit", { state: r.state, outcome: r.outcome, reason: r.reason });
}
done({ outcome, payload: job.payload, payload_sha256: payloadHash, approval: { card_id: card.id, payload_hash: payloadHash, engine_approval: job.payload.engine_approval, by: "tap" },
  prepared: { result: prepared.result, evidence: prepared.evidence }, replay: { result: replay!.result, readback: replay!.evidence?.readback ?? null }, cloud: cloudRun });
