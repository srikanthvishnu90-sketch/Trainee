// Cloud-side preparation for a hash-bound Messages tap. Dry runs do not submit; no approval is inferred from text.
import { prepare, assertApprovedPayload, type RunEngine } from "../career-browser/approve-first.ts";
import { questionsToStore } from "../career-browser/ask-once.ts";
import { readEngineInput } from "./engine_input.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { assertCurrentApprovedSources, type CardCloudRpc } from "./current_sources.ts";
import { cloudEngineRunner } from "./worker.ts";
import { trustedManifest } from "../../extension/src/apply_core.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const fail = (code: string): never => { throw Object.assign(Error(code), { code }); };
const bytesOf = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((n) => n.toString(16).padStart(2, "0")).join("");

export interface CloudCardPreparation { owner: string; thread: string; urls: string[]; resumeSha256: string }
export async function prepareCloudCard(o: CloudCardPreparation, d: {
  rpc: CardCloudRpc; runEngine: RunEngine; tmpRoot?: string; now?: () => number;
}) {
  if (!UUID.test(o.owner) || !UUID.test(o.thread) || !SHA.test(o.resumeSha256) ||
    !Array.isArray(o.urls) || o.urls.length < 1 || o.urls.length > 100 || new Set(o.urls).size !== o.urls.length)
    fail("INVALID_CLOUD_CARD_PREPARATION");
  for (const u of o.urls) {
    let parsed: URL;
    try { parsed = new URL(u); } catch { fail("INVALID_CLOUD_CARD_PREPARATION"); }
    if (parsed!.protocol !== "https:" || parsed!.username || parsed!.password) fail("INVALID_CLOUD_CARD_PREPARATION");
  }
  // Eligibility is checked server-side before even a dry run. Enrollment remains empty by default.
  const context = await d.rpc("career_apply_message_cloud_prepare_context", { p_user: o.owner, p_resume: o.resumeSha256 });
  const r = context?.resume, account = context?.account;
  if (!object(r) || !object(account) || r.sha256 !== o.resumeSha256 || typeof r.b64 !== "string" ||
    typeof r.filename !== "string" || !/^[^/\\.][^/\\]{0,199}$/.test(r.filename) ||
    !Number.isSafeInteger(account.epoch) || !Number.isSafeInteger(account.version)) fail("INVALID_CLOUD_PREPARE_CONTEXT");
  const bytes = bytesOf(r.b64);
  if (!bytes.length || bytes.length > 5 * 1024 * 1024 || await sha256(bytes) !== r.sha256) fail("RESUME_CHANGED");
  const snapshot = await d.rpc("career_apply_message_cloud_sources", { p_user: o.owner });
  if (!object(snapshot) || !Object.hasOwn(snapshot, "profile") || !Array.isArray(snapshot.rows) ||
    snapshot.user_id !== o.owner ||
    await hashApplyPayload({ user_id: o.owner, profile: snapshot.profile, rows: snapshot.rows }) !== snapshot.digest)
    fail("CARD_CLOUD_SOURCE_READ_FAILED");
  const input = await readEngineInput({ latestProfile: async () => snapshot.profile,
    answeredRows: async () => snapshot.rows }, o.owner, r.sha256);
  const manifest = trustedManifest({ owner: o.owner, file: input.facts, rows: input.facts.text_answers,
    resume: { sha256: r.sha256 } });
  const dir = await Deno.makeTempDir({ dir: d.tmpRoot, prefix: "trainee-cloud-prepare-" });
  const items: Record<string, unknown>[] = [], questions: { job: string; asked: number }[] = [];
  try {
    await Deno.chmod(dir, 0o700);
    await Deno.mkdir(`${dir}/resume`, { mode: 0o700 });
    const resumePath = `${dir}/resume/${r.filename}`, factsPath = `${dir}/facts.json`;
    await Deno.writeFile(resumePath, bytes, { mode: 0o600 });
    await Deno.writeTextFile(factsPath, JSON.stringify(input.facts), { mode: 0o600 });
    for (const url of o.urls) {
      let dry: any = null;
      const p = await prepare({ url, factsPath, resumePath, account: { epoch: account.epoch, version: account.version },
        now: (d.now ?? Date.now)(), runEngine: async (...args) => { dry = await d.runEngine(...args); return dry; } });
      if (!p.ready) {
        const result = dry?.result;
        // What stopped it is named, the field included (MULTI_STEP_NEEDS_APPROVAL, "LOOKUP_NEEDS_APPROVAL: Location").
        if (result?.reason !== "needs_answers") {
          return { ready: false as const, reason: "PREPARATION_REFUSED", stopped: String(result?.reason ?? result?.state ?? "ENGINE_NO_RESULT").slice(0, 200), result: p.result };
        }
        const { posting, questions: q } = questionsToStore(result, { facts: manifest.answers,
          answered: new Set(input.facts.text_answers.map((row) => row.key)) });
        if (!posting) fail("ENGINE_POSTING_MISSING");
        const count = q.length ? await d.rpc("career_apply_message_cloud_prepare_questions_as", {
          p_user: o.owner, p_job_id: posting, p_questions: q,
        }) : 0;
        if (!Number.isSafeInteger(count) || count < 0 || count > q.length) fail("INVALID_QUESTION_RECEIPT");
        questions.push({ job: posting, asked: count });
        continue;
      }
      const payload: any = p.payload, ev = dry?.evidence;
      await assertApprovedPayload(payload, { url, user_id: o.owner });
      if (payload.resume_sha256 !== r.sha256 || !object(ev?.payload?.resume) ||
        ev.payload.resume.filename !== r.filename || ev.payload.resume.sha256 !== r.sha256 ||
        !Array.isArray(ev.schema) || !object(ev.readback)) fail("INVALID_CLOUD_READBACK");
      const names = new Set(payload.fields.map((f: any) => f.name));
      const answers = payload.fields.map((f: any) => {
        const field = ev.schema.find((s: any) => s.name === f.name);
        if (!field) fail("INVALID_CLOUD_READBACK");
        let shown: any = f.factId === `approved-local-resume:${r.sha256}` ? r.filename : ev.readback[f.name];
        if (typeof shown === "boolean") shown = shown ? "Yes (checked)" : "No (left unchecked)";
        if (Array.isArray(shown) && shown.every((v) => typeof v === "string")) shown = shown.join(", ");
        if (typeof shown !== "string") fail("INVALID_CLOUD_READBACK");
        return { name: f.name, label: f.label, value: f.value, shown, factId: f.factId };
      });
      items.push({ payload, hash: p.hash, readback: { answers, resume_name: r.filename, resume_sha256: r.sha256,
        destination: payload.destination, blank: ev.schema.filter((f: any) => !names.has(f.name)).map((f: any) => String(f.label || f.name)),
        employer_fields: payload.page_field_names } });
    }
    // A batch with a missing answer is not partly approved: answer the questions and prepare the entire card anew.
    if (questions.length) return { ready: false as const, reason: "needs_answers", questions };
    if (items.length !== o.urls.length) fail("INCOMPLETE_CLOUD_CARD");
    const latest = await d.rpc("career_apply_message_cloud_sources", { p_user: o.owner });
    if (!object(latest) || latest.user_id !== o.owner || !Object.hasOwn(latest, "profile") || !Array.isArray(latest.rows) ||
      await hashApplyPayload({ user_id: o.owner, profile: latest.profile, rows: latest.rows }) !== latest.digest)
      fail("CARD_CLOUD_SOURCE_READ_FAILED");
    const current = await readEngineInput({ latestProfile: async () => latest.profile,
      answeredRows: async () => latest.rows }, o.owner, r.sha256);
    for (const item of items) assertCurrentApprovedSources(item.payload, current);
    const card = await d.rpc("career_apply_message_cloud_card_show_as", { p_user: o.owner, p_thread: o.thread, p_items: items });
    if (!object(card) || !object(card.payload) || card.payload.user_id !== o.owner || card.payload.thread_id !== o.thread ||
      card.payload.version !== 2 || card.payload.execution_mode !== "cloud" ||
      await hashApplyPayload(card.payload) !== card.hash ||
      await hashApplyPayload(card.payload.items) !== await hashApplyPayload(items)) fail("INVALID_CLOUD_CARD_RECEIPT");
    return { ready: true as const, card };
  } finally { await Deno.remove(dir, { recursive: true }).catch(() => {}); }
}

// An explicit operator invocation on the existing worker machine. No loop, automatic approval, enrollment or send.
if (import.meta.main) {
  const [owner, thread, resumeSha256, ...urls] = Deno.args;
  const base = Deno.env.get("SUPABASE_URL") ?? "", key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base || !key || !owner || !thread || !resumeSha256 || !urls.length) {
    console.error("usage: prepare.ts <owner UUID> <thread UUID> <owned resume SHA-256> <https posting>...");
    Deno.exit(1);
  }
  const rpc: CardCloudRpc = async (name, body) => {
    const response = await fetch(`${base.replace(/\/$/, "")}/rest/v1/rpc/${name}`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw Error(`CLOUD_PREPARATION_RPC_REFUSED:${response.status}`);
    return response.json();
  };
  try {
    const runEngine = cloudEngineRunner({ root: new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
      evidenceRoot: Deno.env.get("CLOUD_EVIDENCE_DIR") ?? "/tmp/trainee-cloud-evidence" });
    const result = await prepareCloudCard({ owner, thread, resumeSha256, urls }, { rpc, runEngine });
    console.log(JSON.stringify(result.ready ? { ready: true, card_id: result.card.id, hash: result.card.hash }
      : { ready: false, reason: result.reason }));
  } catch (e: any) { console.error(String(e?.code ?? "CLOUD_PREPARATION_FAILED")); Deno.exit(1); }
}
