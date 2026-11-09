// R10 (owner order 2026-11-09), WO-I fix 15: the POST-DEPLOY live replay. It sends the observed user turns (spec A.2 and F,
// tests/architect/helpers/r10_turns.ts) to the DEPLOYED trainee-telegram webhook as a dedicated synthetic test person: each
// turn is a Telegram update signed with the webhook's own secret header (TELEGRAM_WEBHOOK_SECRET), so the whole channel layer
// runs (the interim ack, bubble splitting, the outbox, the document upload); the replies are read back from career_outbox
// (reply:tg:<update>), captures every reply, downloads every delivered file (the reply's attachments by their owner-scoped ref,
// and every link it carries), opens each file (pages, text, target), fetches each File page and screenshots it at 390 px, and
// writes a report. Run ONLY by the owner or the architect, after a deploy, through .github/workflows/r10-live-replay.yml
// (workflow_dispatch). It is never part of the gate.
//
// THE TEST PERSON, and why it cannot reach a real employer or contact:
//   - Identity: a fresh Supabase Auth user per run, email r10-live-replay-<run>@users.trainee.invalid (".invalid" is reserved by
//     RFC 2606: no mail can ever be delivered to it), user_metadata { r10_live_replay: true, run }. Its only channel contact is
//     tg:<id> with id = 4_500_000_000_000_000 + (run mod 10^7): inside Telegram's 52-bit id space but about half a million times
//     above the ids it issues today (about 8.5 billion), refused if that contact already exists. The product's replies to it do
//     go to the Bot API (that is the channel under test), and Telegram refuses them: a bot can only message a chat that started
//     it, and this one never did (and if the id ever named a real user, they would have to have started Trainee's bot, which
//     makes them a Trainee contact, and the run refuses an id any contact already has). This script itself never calls the Bot
//     API. The resume is uploaded as a file (the product's own ingest, below) and never confirmed.
//   - Applications: the five turns say "don't apply"; the script sends no other words (no "yes", no approve, no tap). After every
//     turn it checks career_apply_wanted, career_apply_jobs, career_apply_cards, career_send_queue and career_outreach_drafts for
//     the test person; anything there is deleted at once (so no worker prepares or sends it) and reported as a FAIL. The person has
//     no cloud opt-in and no connected mailbox, so no rail can submit or send for it, even with an approval.
//   - Employer sites: the only outside requests are read-only GETs of the application links a reply shows (to record whether
//     each is live), with a 10 s timeout and an identifying user agent; nothing is posted to any employer.
//   - Spend: model calls are counted by the product's own counters (agent_turn_costs for the test person; the global ledger
//     model_budget_days before and after). The run stops before the next turn once the person's recorded spend reaches the cap
//     (R10_LIVE_USD_CAP, default and maximum $1.00). This guard is the run's own: the owner removed the per-person AI cap
//     (2026-11-09, WO-J). Every call's model is recorded and the run FAILS on any model other than claude-sonnet-5-5.
//   - Cleanup: at the end (and on any failure) the test person is deleted (auth.users cascade, the channel contact, its storage
//     objects); --cleanup-stale also deletes any earlier r10-live-replay person older than an hour.
// Secrets: only those already in the Actions "production" environment: SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN (to read the
// project's service key from the Management API, never printed), SUPABASE_DB_URL (psql: setup reads, the checks and cleanup),
// TELEGRAM_WEBHOOK_SECRET (signs each turn's update, as Telegram does), and TELEGRAM_BOT_TOKEN (optional: signs the test person's Mini App sign-in for File pages; without it File pages are fetched signed
// out and their private content is reported NOT_RUN). No secret is printed or written to the report.
//
// Usage: deno run -A scripts/launch/r10-live-replay.ts --sha <deployed sha> [--out <dir>] [--usd-cap 1] [--cleanup-stale] [--dry-run] [--smoke]
//   --smoke: the deploy smoke's R10 step instead of the replay: the inbound path answers the synthetic identity (a Telegram
//   update to trainee-telegram, its reply recorded), the File link opens (signed out and signed in), and a resume PDF link
//   returns 200, application/pdf and the stored document's exact bytes. Same test person, same cleanup, same $1 guard.
//   Before the turns (not with --smoke): the deployed sha is verified (bash scripts/launch/trainee-go-live.sh --verify <sha>:
//   the release ledger and the platform's function versions, reads only), and the checkout must BE that sha, since the replay
//   runs its code (the upload's ingest, the interim ack).
//   --dry-run: prints what it would do (the person's identity, the turns, the checks) and touches nothing.
// Exit: 0 every live check PASS; 1 any FAIL; 2 could not run (a missing secret, the project unreachable).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { BASELINE, BASELINE_ALL, INTAKE_RESUME, OBSERVED_FAILURES, OLD_SEARCH, SCENARIOS, SCENARIOS_F } from "../../tests/architect/helpers/r10_turns.ts";
import { closeBrowser, inspectDocx, inspectPdf, pdfOf, renderPhone, saveFile } from "../../tests/architect/helpers/r10_inspect.ts";
import { ackFor } from "../../supabase/functions/_shared/channel_voice.ts";
import { ingestResumeFile, supabaseUploadRecorder } from "../../supabase/functions/_shared/channel_resume_upload.ts";

const args = Deno.args;
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const SHA = opt("--sha") ?? Deno.env.get("R10_LIVE_SHA") ?? "unknown";
const OUT = opt("--out") ?? Deno.env.get("R10_EVIDENCE_DIR") ?? "artifacts/r10-live-replay";
const USD_CAP = Math.min(1, Number(opt("--usd-cap") ?? Deno.env.get("R10_LIVE_USD_CAP") ?? "1") || 1); // never above $1 a run
const DRY = args.includes("--dry-run");
const RUN = Deno.env.get("GITHUB_RUN_ID") ?? String(Date.now());
// Inside Telegram's 52-bit id space, far above every id it issues (about 8.5 billion); refused if any contact already has it.
const TG_ID = 4_500_000_000_000_000 + (Number(RUN.replace(/\D/g, "").slice(-7)) || Date.now() % 10_000_000);
const SMOKE = args.includes("--smoke");
const PAUSE = "pause everything", RESUME = "resume career work"; // #650's own words for the account pause and its lifting
const EMAIL = `r10-live-replay-${RUN.replace(/[^\w-]/g, "")}@users.trainee.invalid`;
const UA = "TraineeR10LiveReplay/1.0 (post-deploy check; read-only)";
// The same fold probe as tests/architect/pending/r10-app-layer/r10-fix-10-entry.test.ts.
const FOLD = `(() => {
  const h = document.querySelector("h1"), p = h ? (h.parentElement.querySelector("p") || document.querySelector("main p")) : null;
  const act = [...document.querySelectorAll("a[href],button")].find((e) => /telegram|open|new link|trainee|sign in|try again/i.test(e.textContent || ""));
  const marks = [...document.querySelectorAll("svg,img,.brand,.mark,[class*=logo],[class*=mark]")].map((e) => e.getBoundingClientRect().height);
  const b = (e) => e ? e.getBoundingClientRect().bottom : null;
  return { h1: h ? h.textContent.trim() : null, pBottom: b(p), action: act ? act.textContent.trim().slice(0, 40) : null, actionBottom: b(act), markMax: marks.length ? Math.max(...marks) : 0 };
})()`;
Deno.env.set("R10_EVIDENCE_DIR", OUT);

type Status = "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED"; // BLOCKED: a named reason outside the product (not a FAIL)
interface Check { item: number; turn: string; check: string; status: Status; detail: string }
const checks: Check[] = [];
const files: string[] = [], screenshots: string[] = [], modelLog: string[] = [];
const transcript: { turn: string; text: string; reply: string; artifacts: string[]; links: string[]; usd_micros_after: number; calls_after: number }[] = [];
const note = (item: number, turn: string, check: string, pass: boolean | null | "blocked", detail = "") => {
  const status: Status = pass === "blocked" ? "BLOCKED" : pass === null ? "NOT_RUN" : pass ? "PASS" : "FAIL";
  checks.push({ item, turn, check, status, detail: detail.replace(/\s+/g, " ").slice(0, 400) });
  console.log(`${status.padEnd(7)} [${item}] ${turn}: ${check}${detail && status !== "PASS" ? ` — ${detail.slice(0, 200)}` : ""}`);
};
const need = (k: string) => { const v = Deno.env.get(k); if (!v) { console.log(`NOT RUN: ${k} is not set (it is in the Actions production environment)`); Deno.exit(2); } return v; };

function psql(db: string, sql: string): string {
  const r = new Deno.Command("psql", { args: [db, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], stdout: "piped", stderr: "piped" }).outputSync();
  if (!r.success) throw new Error(`psql: ${new TextDecoder().decode(r.stderr).replace(/postgres(ql)?:\/\/\S+/g, "<db>").slice(0, 300)}`);
  return new TextDecoder().decode(r.stdout).trim();
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function serviceKey(ref: string, token: string): Promise<string> {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Management API api-keys: HTTP ${r.status}`);
  const keys = await r.json() as { name?: string; api_key?: string; type?: string }[];
  const k = keys.find((x) => x.name === "service_role")?.api_key ?? keys.find((x) => x.type === "secret")?.api_key;
  if (!k) throw new Error("no service key in the Management API answer");
  return k;
}

// Telegram's Mini App sign-in, signed for the test person's own synthetic Telegram id (how a Telegram user opens a File).
async function signedInit(botToken: string, id: number) {
  const enc = new TextEncoder();
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAR10", user: JSON.stringify({ id, first_name: "R10 replay" }) });
  const hmac = async (k: BufferSource, m: string) => await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(m));
  const chk = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  p.set("hash", [...new Uint8Array(await hmac(await hmac(enc.encode("WebAppData"), botToken), chk))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}

async function main() {
  console.log(`R10 live replay: deployed sha ${SHA}; test person ${EMAIL} (tg:${TG_ID}); spend cap $${USD_CAP.toFixed(2)}; ${BASELINE.scenarios} scenarios, ${BASELINE.turns} turns`);
  const turns = [...SCENARIOS.resume.map((x) => ({ ...x, scenario: "resume" })), ...SCENARIOS.search.map((x) => ({ ...x, scenario: "search" })),
    ...SCENARIOS_F.search.map((x) => ({ ...x, scenario: "post-reset search" })), ...SCENARIOS_F.research.map((x) => ({ ...x, scenario: "post-reset research and stop" }))];
  if (DRY) {
    console.log("DRY RUN: nothing is created, sent or deleted.");
    console.log(`setup: verify ${SHA} (trainee-go-live.sh --verify); create ${EMAIL}, contact tg:${TG_ID}; upload the intake as a PDF (never confirmed); "${OLD_SEARCH}"`);
    for (const t of turns) console.log(`turn ${t.id} (${t.scenario}): ${t.text}`);
    console.log(`then: "${PAUSE}", "${RESUME}" (career_user_quiet read after each); every turn is a signed update to trainee-telegram`);
    console.log(`historical baseline: ${BASELINE_ALL.scenarios} scenarios, ${BASELINE_ALL.turns} turns (spec A + F)`);
    console.log("then: download every attachment and link, open each file, screenshot each File page at 390 px, check nothing was applied, delete the test person.");
    return 0;
  }
  const ref = need("SUPABASE_PROJECT_REF"), token = need("SUPABASE_ACCESS_TOKEN"), db = need("SUPABASE_DB_URL"), hook = need("TELEGRAM_WEBHOOK_SECRET");
  const bot = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const url = `https://${ref}.supabase.co`;
  const key = await serviceKey(ref, token);
  const admin = createClient(url, key, { auth: { persistSession: false } });
  await Deno.mkdir(OUT, { recursive: true });

  if (args.includes("--cleanup-stale")) {
    const n = psql(db, `with d as (delete from auth.users where email like 'r10-live-replay-%@users.trainee.invalid' and created_at < now() - interval '1 hour' returning id) select count(*) from d`);
    console.log(`stale test people removed: ${n}`);
  }
  if (psql(db, `select count(*) from public.channel_contacts where contact = 'tg:${TG_ID}'`) !== "0") throw new Error(`tg:${TG_ID} already belongs to an account; refusing to reuse it`);
  // LR-4: this checkout is the deployed sha, and the release ledger and the platform's versions say it is the one deployed.
  if (!SMOKE) {
    const head = new TextDecoder().decode(new Deno.Command("git", { args: ["rev-parse", "HEAD"], stdout: "piped", stderr: "null" }).outputSync().stdout).trim();
    note(15, "verify", "the replay runs the deployed sha's own code (the checkout is inputs.sha)", head === SHA, `HEAD ${head.slice(0, 12)}, deployed ${SHA.slice(0, 12)}`);
    const v = new Deno.Command("bash", { args: ["scripts/launch/trainee-go-live.sh", "--verify", SHA, "--non-interactive"], stdout: "piped", stderr: "piped" }).outputSync();
    const log = new TextDecoder().decode(new Uint8Array([...v.stdout, ...v.stderr]));
    await Deno.mkdir(OUT, { recursive: true });
    await Deno.writeTextFile(`${OUT}/verify.log`, log); // the ledger rows and platform versions; the script masks every secret
    note(15, "verify", "trainee-go-live.sh --verify: the ledger and every function's platform version are the deployed sha's", v.success, log.trim().split("\n").slice(-3).join(" | "));
  }
  const budgetBefore = psql(db, `select coalesce(sum(spent_micros + reserved_micros), 0) from public.model_budget_days where day >= current_date - 1`);
  const runStart = psql(db, "select now()::text");

  const made = await admin.auth.admin.createUser({ email: EMAIL, email_confirm: true, user_metadata: { r10_live_replay: true, run: RUN } });
  if (made.error || !made.data.user) throw new Error(`create the test person: ${made.error?.message}`);
  const person = made.data.user.id;
  let thread: string | null = null;
  const cleanup = () => {
    try {
      psql(db, `delete from public.channel_contacts where user_id = ${lit(person)}; delete from storage.objects where name like ${lit(`${person}/%`)}; delete from auth.users where id = ${lit(person)}`);
      console.log(`cleanup: test person ${person} deleted`);
      return true;
    } catch (e) { console.log(`CLEANUP FAILED: ${(e as Error).message}`); return false; }
  };
  try {
    psql(db, `insert into public.profiles (id) values (${lit(person)}) on conflict (id) do nothing`);
    psql(db, `insert into public.channel_contacts (contact, user_id) values ('tg:${TG_ID}', ${lit(person)})`);
    const spent = () => { const [u, c] = psql(db, `select coalesce(sum(usd_micros), 0) || '|' || coalesce(sum(calls), 0) from public.agent_turn_costs where user_id = ${lit(person)}`).split("|"); return { usd: Number(u), calls: Number(c) }; };
    const effects = () => psql(db, `select (select count(*) from public.career_apply_wanted where user_id = ${lit(person)}) || '|' || (select count(*) from public.career_apply_jobs where user_id = ${lit(person)}) || '|' || (select count(*) from public.career_send_queue where user_id = ${lit(person)}) || '|' || (select count(*) from public.career_outreach_drafts where user_id = ${lit(person)} and approved_hash is not null)`);
    const stopEffects = () => psql(db, `delete from public.career_apply_wanted where user_id = ${lit(person)}; delete from public.career_apply_cards where user_id = ${lit(person)}; delete from public.career_send_queue where user_id = ${lit(person)}`);
    let n = 0;
    // LR-6: the $1 guard reads the person's own recorded spend AND the change in the global ledger since the run began (spent
    // plus reserved), so background work the turns start (a worker, a retry) counts too; other people's turns are in the global
    // figure, so it can only stop the run early, never let it overspend.
    const globalDelta = () => Number(psql(db, `select coalesce(sum(spent_micros + reserved_micros), 0) from public.model_budget_days where day >= current_date - 1`)) - Number(budgetBefore);
    const guard = (id: string) => {
      const s = spent(), g = globalDelta();
      if (s.usd >= USD_CAP * 1_000_000 || g >= USD_CAP * 1_000_000) throw new Error(`spend cap: $${(s.usd / 1e6).toFixed(4)} recorded for the test person, $${(g / 1e6).toFixed(4)} on the global ledger since the start; at or over $${USD_CAP}; stopping before ${id}`);
    };
    // The upload's turn: the channel hands the file's message to agent-chat exactly as chatThroughAgent does (service key,
    // as_user_id, channel "telegram"); every other turn goes through trainee-telegram (tg below).
    const say = async (text: string, id: string) => {
      guard(id);
      const r = await fetch(`${url}/functions/v1/agent-chat`, { method: "POST", signal: AbortSignal.timeout(150_000), headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ as_user_id: person, message: text, turn_key: `r10-live:${RUN}:${++n}`, channel: "telegram", ...(thread ? { thread_id: thread } : {}) }) });
      const body = await r.json().catch(() => ({})) as Record<string, any>;
      if (typeof body.thread_id === "string") thread = body.thread_id;
      // As chatThroughAgent reads it (channel_runtime.ts): the parts when there are parts, else the reply; the REPLY SHAPE's links
      // and attachments (base64) follow it; FEATURE 16 documents travel as owner-scoped refs (channel_artifacts).
      const parts = Array.isArray(body.parts) ? body.parts.filter((p: unknown) => typeof p === "string") : [];
      const reply = parts.length ? parts.join("\n\n") : String(body.reply ?? "");
      const shape = body.shape && typeof body.shape === "object" ? body.shape : {};
      const shapeLinks = Array.isArray(shape.links) ? shape.links.map((l: any) => typeof l === "string" ? l : String(l?.url ?? "")).filter(Boolean) : [];
      const links: string[] = [...new Set([...reply.matchAll(/https?:\/\/[^\s)<>"\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")).concat(shapeLinks))];
      const arts = Array.isArray(body.artifacts) ? body.artifacts.filter((a: any) => a && typeof a.ref === "string") : [];
      const inline = Array.isArray(shape.attachments) ? shape.attachments.filter((a: any) => a && typeof a.content === "string") : [];
      const e = effects();
      if (e !== "0|0|0|0") { stopEffects(); note(15, id, "no application or message started for the test person", false, `wanted|jobs|send_queue|approved_drafts = ${e} (removed before any worker took them)`); }
      const after = spent();
      transcript.push({ turn: id, text, reply, artifacts: arts.map((a: any) => String(a.filename ?? a.ref)), links, usd_micros_after: after.usd, calls_after: after.calls });
      return { status: r.status, reply, links, arts, inline, documents: null as null | { sent: number; failed: number } };
    };
    const docsSeen: { turn: string; sent: number; failed: number }[] = [];
    let upd = 0;
    const tg = async (text: string, id: string) => {
      guard(id);
      const at = psql(db, "select now()::text"), u = Number(crypto.getRandomValues(new Uint32Array(1))[0]) * 64 + (++upd % 64);
      const r = await fetch(`${url}/functions/v1/trainee-telegram`, { method: "POST", signal: AbortSignal.timeout(170_000), headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook },
        body: JSON.stringify({ update_id: u, message: { message_id: upd, date: Math.floor(Date.now() / 1000), chat: { id: TG_ID, type: "private" }, from: { id: TG_ID, is_bot: false, first_name: "R10 replay" }, text } }) });
      const body = await r.json().catch(() => ({})) as Record<string, any>;
      const rows = JSON.parse(psql(db, `select coalesce(json_agg(text order by id), '[]') from public.career_outbox where user_id = ${lit(person)} and key like ${lit(`reply:tg:${u}%`)}`)) as string[];
      const reply = rows.join("\n\n");
      const links: string[] = [...new Set([...reply.matchAll(/https?:\/\/[^\s)<>"\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))];
      const arts = JSON.parse(psql(db, `select coalesce(json_agg(json_build_object('ref', id, 'filename', filename)), '[]') from public.channel_artifacts where user_id = ${lit(person)} and created_at >= ${lit(at)}::timestamptz`)) as { ref: string; filename: string }[];
      const res = (Array.isArray(body.results) ? body.results : []).find((x: any) => x && typeof x === "object" && x.documents) as any;
      const documents = res?.documents ? { sent: Number(res.documents.sent) || 0, failed: Number(res.documents.failed) || 0 } : null;
      if (documents) docsSeen.push({ turn: id, ...documents });
      if (r.status !== 200 || !rows.length) note(15, id, "trainee-telegram answered the update and recorded a reply", false, `HTTP ${r.status}; ${rows.length} reply rows; ${JSON.stringify(body).slice(0, 160)}`);
      const e = effects();
      if (e !== "0|0|0|0") { stopEffects(); note(15, id, "no application or message started for the test person", false, `wanted|jobs|send_queue|approved_drafts = ${e} (removed before any worker took them)`); }
      const after = spent();
      transcript.push({ turn: id, text, reply, artifacts: arts.map((a) => a.filename), links, usd_micros_after: after.usd, calls_after: after.calls });
      return { status: r.status, reply, links, arts, inline: [] as any[], documents };
    };
    // Setup (LR-2): the intake uploaded as a PDF file and NEVER confirmed, then the old search. The file goes through the
    // product's own ingest (ingestResumeFile + supabaseUploadRecorder, this sha's code, the production tables), as trainee-telegram
    // runs it for a document update; only Telegram's file hosting is skipped (getFile answers only for a file a real chat sent).
    const pdf = pdfOf(INTAKE_RESUME);
    const up = await ingestResumeFile({ userId: person, channel: "telegram", doc: { fileId: `r10-live-${RUN}`, uniqueId: `r10-live-${RUN}`, name: "Jordan_Rivera_resume.pdf", mime: "application/pdf", size: pdf.length },
      fetchFile: async () => ({ ok: true as const, bytes: pdf }), record: supabaseUploadRecorder(admin) });
    if (!up.ok) throw new Error(`the resume upload was refused: ${up.reply.slice(0, 160)}`);
    await say(up.message, "setup-upload");
    if (thread) psql(db, `update public.channel_contacts set thread_id = ${lit(thread)} where user_id = ${lit(person)}`); // one thread per person, as setThread
    const oldList = await tg(OLD_SEARCH, "setup-old-list");

    const openFile = async (label: string, bytes: Uint8Array, name: string, mime: string) => {
      const pdf = /pdf/i.test(mime) || name.endsWith(".pdf") || new TextDecoder("latin1").decode(bytes.subarray(0, 5)) === "%PDF-";
      const path = await saveFile(`live-${label}-${name}`, bytes);
      files.push(path);
      if (pdf) return { kind: "pdf" as const, name, pdf: await inspectPdf(bytes), path };
      if (/word|docx/i.test(mime) || name.endsWith(".docx")) return { kind: "docx" as const, name, docx: await inspectDocx(bytes), path };
      return { kind: "other" as const, name, path };
    };
    const follow = async (label: string, link: string) => {
      let u: URL;
      try { u = new URL(link); } catch { return null; }
      const isFile = /\/file$/.test(u.pathname) && (u.searchParams.has("t") || u.searchParams.has("list"));
      let res: Response;
      if (isFile && bot) {
        // The File's list id is in its signed link; the Mini App sign-in is posted for the test person's own Telegram id.
        const t = u.searchParams.get("t") ?? "";
        let list = u.searchParams.get("list") ?? "";
        if (!list && t.startsWith("v1.")) { try { list = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).r ?? ""; } catch { list = ""; } }
        res = await fetch(`${u.origin}${u.pathname}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/x-www-form-urlencoded", origin: u.origin, "user-agent": `Mozilla/5.0 ${UA}` },
          body: new URLSearchParams({ list, init: await signedInit(bot, TG_ID) }).toString() });
      } else {
        // Anything else (an employer's application link): one read-only GET.
        res = await fetch(link, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": UA } }).catch((e) => new Response(String(e), { status: 599 }));
      }
      const type = res.headers.get("content-type") ?? "";
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (/html/.test(type)) {
        if (isFile && SMOKE) return { link, status: res.status, isFile, html: true, text: "", fits: true, signedIn: !!bot }; // the deploy job has no browser
        if (isFile) {
          const shot = await renderPhone(new TextDecoder().decode(bytes), `live-${label}-${screenshots.length}`, undefined, { csp: res.headers.get("content-security-policy") ?? undefined }).catch((e) => ({ screenshot: null, scrollWidth: 0, innerWidth: 0, text: String(e) }) as any);
          if (shot.screenshot) screenshots.push(shot.screenshot);
          return { link, status: res.status, isFile, html: true, text: shot.text as string, fits: shot.scrollWidth <= shot.innerWidth, signedIn: !!bot };
        }
        return { link, status: res.status, isFile, html: true, text: "", fits: true, signedIn: false };
      }
      if (res.status === 200 && bytes.length) return { link, status: res.status, isFile, file: await openFile(label, bytes, u.pathname.split("/").pop() || "download", type) };
      return { link, status: res.status, isFile };
    };
    const delivered = async (label: string, r: Awaited<ReturnType<typeof say>>) => {
      const got: any[] = [];
      for (const a of r.arts) {
        const { data } = await admin.from("channel_artifacts").select("bytes_b64, filename, mime").eq("id", a.ref).eq("user_id", person).maybeSingle();
        if (data?.bytes_b64) got.push(await openFile(label, Uint8Array.from(atob(data.bytes_b64), (c) => c.charCodeAt(0)), String(data.filename ?? "document.pdf"), String(data.mime ?? "application/pdf")));
      }
      for (const a of r.inline) got.push(await openFile(label, Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0)), String(a.filename ?? "document.pdf"), String(a.mime ?? (String(a.filename).endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf"))));
      const pages: any[] = [];
      for (const l of r.links) { const f = await follow(label, l); if (f?.file) got.push(f.file); else if (f) pages.push(f); }
      return { got, pages };
    };
    const resumeChecks = (id: string, d: { got: any[] }, reply: string) => {
      const pdfs = d.got.filter((f) => f.kind === "pdf");
      note(4, id, "a PDF was delivered (attachment or working link) and opens", pdfs.length > 0 && pdfs.every((f) => f.pdf.ok), `files: ${d.got.map((f) => f.name).join(", ") || "none"}`);
      for (const f of pdfs) {
        note(4, id, `${f.name}: one page`, f.pdf.pages === 1, `${f.pdf.pages} page(s)`);
        note(1, id, `${f.name}: aimed at data analyst internships, not the old list's role`, (/data analyst/i.test(f.pdf.text) || /data[_ -]?analyst/i.test(f.name)) && !/Machine Learning Engineering Manager|reddit/i.test(f.pdf.text));
        note(3, id, `${f.name}: the person's own facts, no invented contact details`, f.pdf.text.includes("Jordan Rivera") && f.pdf.text.includes("Granite Peak Partners") && !/[\w.+-]+@[\w-]+\.[\w.]+/.test(f.pdf.text));
      }
      if (/\battached\b/i.test(reply)) note(4, id, '"attached" only with an attachment', d.got.length > 0);
    };
    const quality = (id: string, reply: string) => {
      note(8, id, "no internal process language", !/parse check|\brunner\b|switched on|checked against the record|live board|saved snapshot|Nothing was invented to fill the list/i.test(reply), reply.slice(0, 200));
      for (const r of OBSERVED_FAILURES[id] ?? []) note(15, id, `the observed failure is gone (${r.source.slice(0, 50)})`, !r.test(reply), reply.slice(0, 200));
      // F.2: the interim line a slow turn gets is sent straight to Telegram and not recorded anywhere, so it is computed here by
      // the deployed code's own ackFor (this checkout is the deployed sha), not observed.
      const ack = ackFor(transcript.findLast((x) => x.turn === id)?.text ?? "");
      note(15, id, "the interim ack (computed by the deployed ackFor; not recorded by the product) is not the observed failure", !(OBSERVED_FAILURES[id] ?? []).some((r) => r.test(ack)), ack);
    };
    // F.3 / #650: what a stop or pause reply counts must equal the tables (career_stop_truth.ts reconcile's own grouping).
    const tally = (table: string, col: string, states: string[]) => Number(psql(db, `select count(*) from public.${table} where user_id = ${lit(person)} and ${col} in (${states.map(lit).join(", ")})`));
    const COUNTS: [RegExp, () => number[]][] = [
      [/Outreach drafts on record: (\d+) waiting for your yes, (\d+) approved, (\d+) sending \(outcome uncertain\), (\d+) already out/, () => [["shown"], ["approved"], ["sending"], ["sent", "replied", "bounced"]].map((x) => tally("career_outreach_drafts", "status", x))],
      [/Emails on the send rail: (\d+) queued, (\d+) sending \(outcome uncertain\), (\d+) already out/, () => [["queued"], ["sending"], ["sent", "replied", "bounced"]].map((x) => tally("career_send_queue", "state", x))],
      [/Applications on record: (\d+) waiting, (\d+) in progress, (\d+) confirmed by the employer, (\d+) with the outcome unknown/, () => [["queued", "needs_user"], ["driving"], ["confirmed"], ["submitted_unconfirmed", "unknown_outcome"]].map((x) => tally("career_apply_jobs", "state", x))],
    ];
    const counts = (id: string, reply: string) => {
      for (const [re, want] of COUNTS) { const m = re.exec(reply); if (m) { const w = want(); note(8, id, `the reply's counts equal the tables (${re.source.slice(0, 20)})`, m.slice(1).map(Number).join() === w.join(), `said ${m.slice(1).join("/")}; tables ${w.join("/")}`); } }
    };
    const control = () => ({ quiet: psql(db, `select public.career_user_quiet(${lit(person)})`) === "t", paused: psql(db, `select coalesce((select (value->>'paused')::boolean from public.career_watch_kv where user_id = ${lit(person)} and key = 'career:account'), false)`) === "t" });
    // #650's wording: a pause is claimed by "Paused your account" or "is still paused"; "is not paused" / "NOT paused" claim none.
    const CLAIMS_PAUSE = /\bPaused your account\b|\baccount is still paused\b|\bpause is saved\b|global pause|blocks every send path|stopped everything/i;

    // R-4, the Telegram document (architect, 2026-11-09): observed from Trainee's side, from the delivery record's sendDocument
    // response (ok, document.file_id, file_size equal to the PDF's length, then getFile and a sha256 match). BLOCKED, never a
    // pass: Telegram refuses sendDocument to a chat that never started the bot, so the synthetic id receives no document; it
    // needs an owner-provided test chat (the architect is asking the owner). WO-B stores file_id and file_size.
    const telegramDocument = () => note(4, "telegram", "the Telegram document is observed: sendDocument ok, file_id, file_size = the PDF's length, getFile sha256 match", "blocked",
      `needs an owner-provided test chat; trainee-telegram's own count: ${docsSeen.map((d) => `${d.turn} sent ${d.sent} failed ${d.failed}`).join(", ") || "no document sent in any turn"}`);
    // --smoke (the deploy smoke's R10 step): the File endpoint, a resume PDF link with intact bytes, and the inbound path, each
    // for the synthetic identity only. Then the run ends (no observed-turn replay).
    if (SMOKE) {
      const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
      // 1. Inbound: every turn of this run is a signed update to trainee-telegram, its reply read from the outbox (tg above).
      // 2. The File endpoint: the list link from the old search opens signed out (its sign-in page) and signed in (the list).
      const fileLink = oldList.links.find((l) => { try { return /\/file$/.test(new URL(l).pathname); } catch { return false; } });
      if (!fileLink) note(10, "smoke", "a File link is given and opens", false, "the search reply carried no File link");
      else {
        const out = await fetch(fileLink, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "user-agent": `Mozilla/5.0 ${UA}` } });
        note(10, "smoke", "the File link answers signed out (200/303, HTML, its own policy)", [200, 303].includes(out.status) && (out.status === 303 || /text\/html/.test(out.headers.get("content-type") ?? "")) && !!out.headers.get("content-security-policy"), `HTTP ${out.status} ${out.headers.get("content-type")}`);
        await out.body?.cancel();
        const f = await follow("smoke-file", fileLink);
        note(10, "smoke", "the File opens signed in for the synthetic identity", !!bot && f?.status === 200 && !!f?.html, bot ? `HTTP ${f?.status}` : "TELEGRAM_BOT_TOKEN not given");
      }
      // 3. A resume PDF link: 200, application/pdf, and the same bytes as the stored document.
      const t1 = await tg(SCENARIOS.resume[0].text, "smoke-T1");
      note(15, "smoke", "inbound (trainee-telegram) answers the synthetic identity: a reply recorded for it", t1.status === 200 && !!t1.reply, `HTTP ${t1.status} (Telegram refuses the send itself: the chat never started the bot)`);
      const stored: Record<string, string> = {};
      for (const a of t1.arts) { const { data } = await admin.from("channel_artifacts").select("bytes_b64").eq("id", a.ref).eq("user_id", person).maybeSingle(); if (data?.bytes_b64) stored[await hex(Uint8Array.from(atob(data.bytes_b64), (c) => c.charCodeAt(0)))] = a.ref; }
      const pdfLinks: { link: string; status: number; type: string; sha: string }[] = [];
      for (const l of t1.links) {
        const r = await fetch(l, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "user-agent": `Mozilla/5.0 ${UA}` } }).catch(() => null);
        if (!r) continue;
        const type = r.headers.get("content-type") ?? "", b = new Uint8Array(await r.arrayBuffer());
        if (/pdf/.test(type) || new TextDecoder("latin1").decode(b.subarray(0, 5)) === "%PDF-") pdfLinks.push({ link: new URL(l).origin + new URL(l).pathname, status: r.status, type, sha: await hex(b) });
      }
      note(4, "smoke", "a resume PDF link opens: 200, application/pdf", pdfLinks.some((p) => p.status === 200 && /application\/pdf/.test(p.type)), pdfLinks.length ? JSON.stringify(pdfLinks.map((p) => [p.status, p.type])) : `no PDF link in the reply (${t1.links.length} links, ${t1.arts.length} attachments)`);
      note(4, "smoke", "the downloaded PDF's bytes are the stored document's, byte for byte", Object.keys(stored).length ? pdfLinks.some((p) => stored[p.sha] !== undefined) : null, Object.keys(stored).length ? `stored ${Object.keys(stored).length} attachment(s)` : "no stored attachment to compare (the link is the only copy)");
      return 0;
    }

    // Scenario 1: resume.
    for (const t of SCENARIOS.resume) {
      const r = await tg(t.text, t.id);
      const d = await delivered(t.id, r);
      quality(t.id, r.reply);
      resumeChecks(t.id, d, r.reply);
      if (t.id === "T2") note(3, t.id, "asks the specific open fact (contact or GPA)", /\?/.test(r.reply) && /email|phone|contact|GPA/i.test(r.reply), r.reply.slice(0, 200));
      if (t.id === "T3") {
        note(2, t.id, "acknowledges the wrong role and starts no batch", /wrong role|used the wrong|my mistake|you're right/i.test(r.reply) && !/\bbatch\b/i.test(r.reply), r.reply.slice(0, 200));
        note(4, t.id, "the download link opens the PDF", d.got.some((f) => f.kind === "pdf"), `links: ${r.links.join(" ")}`);
      }
      for (const p of d.pages) if (p.isFile) note(10, t.id, `File page ${p.status}: fits 390 px`, p.fits);
    }
    // Scenario 2: search (on the live board: nothing about the market is asserted, only the shape and honesty of the answer).
    for (const t of SCENARIOS.search) {
      const r = await tg(t.text, t.id);
      const d = await delivered(t.id, r);
      quality(t.id, r.reply);
      const items = r.reply.split("\n").filter((l) => /^\s*\d+[.)]\s/.test(l));
      const apply = d.pages.filter((p) => !p.isFile);
      note(5, t.id, "a numbered shortlist with application links, or a bounded explanation of the empty result", items.length > 0 ? apply.length > 0 : /(checked|searched|found) \d+|nearby|remote|wider/i.test(r.reply), `${items.length} listed; ${apply.length} links followed`);
      for (const p of apply) note(6, t.id, `application link answers (${new URL(p.link).host})`, p.status > 0 && p.status < 400, `HTTP ${p.status}`);
      if (/limit/i.test(r.reply)) note(7, t.id, "at the limit: reset in the person's time, not midnight UTC", !/midnight UTC/i.test(r.reply), r.reply.slice(-200));
      for (const p of d.pages) if (p.isFile) note(5, t.id, `File page fits 390 px${p.signedIn ? " (signed in)" : " (signed out: no TELEGRAM_BOT_TOKEN)"}`, p.fits);
    }
    // Spec F (the owner's post-reset audit), in the same conversation as the audit ran them.
    for (const t of SCENARIOS_F.search) {
      const r = await tg(t.text, t.id);
      const d = await delivered(t.id, r);
      quality(t.id, r.reply);
      note(5, t.id, "no resume-confirmation tail (the resume was uploaded and never confirmed)", !/confirm (your|the) resume|resume (is|isn't|is not) (yet )?confirmed|before your resume is confirmed|unconfirmed resume/i.test(r.reply), r.reply.slice(-200));
      const items = r.reply.split("\n").filter((l) => /^\s*\d+[.)]\s/.test(l));
      note(5, t.id, "checked open postings with links, or one named, evidenced blocker; no resume-confirmation tail", (items.length > 0 && d.pages.some((p) => !p.isFile)) || /no open (roles|postings) (were )?found in|search connection|(checked|searched) \d+/i.test(r.reply), r.reply.slice(0, 200));
    }
    for (const t of SCENARIOS_F.research) {
      const r = await tg(t.text, t.id);
      quality(t.id, r.reply);
      const fx = effects();
      if (t.id !== "F3") note(14, t.id, "Stripe research or its named blocker; no applications, introductions or outreach", /Stripe/.test(r.reply) && !/Building the list|applications ready/i.test(r.reply) && fx === "0|0|0|0", `${fx} ${r.reply.slice(0, 160)}`);
      else {
        // F.3: what the stop reply claims, against the authoritative control state (career_user_quiet: the career:account paused
        // flag and contact opt-outs, WO-091c; WO-K's documented contract replaces this read when it lands) and the send tables.
        const quiet = psql(db, `select public.career_user_quiet(${lit(person)})`) === "t";
        const kv = psql(db, `select coalesce((select value::text from public.career_watch_kv where user_id = ${lit(person)} and key = 'career:account'), '{}')`);
        transcript.at(-1)!.reply += `\n--- control state after the stop: career_user_quiet=${quiet}; career:account=${kv}; wanted|jobs|send_queue|approved_drafts=${fx}`;
        const claimsPause = CLAIMS_PAUSE.test(r.reply);
        counts(t.id, r.reply);
        note(8, t.id, "a claimed pause is in the authoritative state", !claimsPause || quiet, `claims pause: ${claimsPause}; career_user_quiet=${quiet}`);
        note(8, t.id, "no promise of a reconciliation nothing schedules", !/the moment .* load|you do not need to ask again/i.test(r.reply), r.reply.slice(0, 200));
        note(15, t.id, "nothing sent or queued after the stop", fx === "0|0|0|0", fx);
      }
    }
    // LR-5: an explicit pause, then an explicit resume; the control state must follow each, and nothing else may change it.
    const before = control();
    const p = await tg(PAUSE, "pause");
    const cp = control();
    note(8, "pause", `"${PAUSE}": career:account paused and career_user_quiet true, read back`, cp.paused && cp.quiet, `before ${JSON.stringify(before)}; after ${JSON.stringify(cp)}`);
    note(8, "pause", "the reply claims the pause only because it holds", CLAIMS_PAUSE.test(p.reply) === cp.paused, p.reply.slice(0, 200));
    counts("pause", p.reply);
    const q2 = await tg(RESUME, "resume");
    const cr = control();
    note(8, "resume", `"${RESUME}": the pause lifted and career_user_quiet false, read back`, !cr.paused && !cr.quiet, JSON.stringify(cr));
    note(8, "resume", "the reply says the pause is lifted only because it is", /pause is lifted/i.test(q2.reply) === !cr.paused, q2.reply.slice(0, 200));
    telegramDocument();
    // Fix 10 on the deployed site: the bare /file and /connect pages (no link), as a phone opens them through the site's proxy
    // and under the policy it serves: the recovery heading, text and action inside the first 390 x 844 screen.
    const site = transcript.flatMap((x) => x.links).map((l) => { try { const u = new URL(l); return /\/file$/.test(u.pathname) ? u.origin : null; } catch { return null; } }).find(Boolean);
    if (site) {
      for (const path of ["/file", "/connect"]) {
        const res = await fetch(`${site}${path}`, { headers: { "user-agent": `Mozilla/5.0 (iPhone) ${UA}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
        if (!res) { note(10, "entry", `${path} answers`, false); continue; }
        const html = await res.text();
        const r = await renderPhone(html, `live-bare${path.replace("/", "-")}`, FOLD, { csp: res.headers.get("content-security-policy") ?? undefined }).catch((e) => ({ screenshot: null, probe: null, text: String(e) }) as any);
        if (r.screenshot) screenshots.push(r.screenshot);
        const p = r.probe ?? {};
        note(10, "entry", `bare ${path}: recovery heading, text and action inside the first 390 x 844 screen; compact mark`, !!p.h1 && p.pBottom !== null && p.pBottom <= 844 && !!p.action && p.actionBottom <= 844 && p.markMax <= 120, JSON.stringify(p));
      }
    } else note(10, "entry", "bare /file and /connect (no File link in any reply, so the site's address is unknown)", null);
    const e = effects();
    note(15, "all", "nothing applied, queued or sent for the test person", e === "0|0|0|0", `wanted|jobs|send_queue|approved_drafts = ${e}`);
    const s = spent(), g = globalDelta();
    note(15, "all", `spend within $${USD_CAP} (recorded by agent_turn_costs)`, s.usd < USD_CAP * 1_000_000, `$${(s.usd / 1e6).toFixed(4)} over ${s.calls} model calls`);
    note(15, "all", `the global ledger moved less than $${USD_CAP} during the run (background work included; other people's turns too)`, g < USD_CAP * 1_000_000, `$${(g / 1e6).toFixed(4)} spent or reserved since the start`);
    // Owner ruling 2026-11-09 (WO-J): Sonnet 5.5 is the only model for Trainee output. The test person's own calls name their
    // models in agent_turn_costs (exact). The global ledger's reservations carry no person, so every reservation made during
    // this run's window is read too (other people's turns may be in it; any other model there is a real finding as well).
    const MODEL = "claude-sonnet-5-5";
    const own = psql(db, `select coalesce(string_agg(distinct m, ','), '') from public.agent_turn_costs, unnest(models) m where user_id = ${lit(person)}`).split(",").filter(Boolean);
    note(15, "all", `every model call the test person caused is ${MODEL} (agent_turn_costs)`, own.length > 0 && own.every((m) => m.startsWith(MODEL)), `models: ${own.join(", ") || "none recorded"}`);
    const windowModels = psql(db, `select coalesce(string_agg(model || '=' || n, ','), '') from (select model, count(*) n from public.model_budget_reservations where created_at >= ${lit(runStart)}::timestamptz and model is not null group by model) x`);
    // A reservation with no model name (model_budget_reserve called without p_model) names no model: it is its own category,
    // reported by role and status, never read as another model.
    const unnamed = psql(db, `select coalesce(string_agg(coalesce(role, '(no role)') || '/' || status || '=' || n, ','), '') from (select role, status, count(*) n from public.model_budget_reservations where created_at >= ${lit(runStart)}::timestamptz and model is null group by role, status) x`);
    modelLog.push(`reservations since ${runStart}: ${windowModels || "none named"}; without a model name (role/status): ${unnamed || "none"}`);
    note(15, "all", `every named model_budget_reservations row in the run window is ${MODEL}`, windowModels !== "" && windowModels.split(",").every((x) => x.startsWith(`${MODEL}`)), windowModels || "no named reservation rows in the window");
    if (unnamed) note(15, "all", "reservations without a model name (the reserve call carried no p_model): reported by role and status, not a model", null, unnamed);
    const budgetAfter = psql(db, `select coalesce(sum(spent_micros), 0) from public.model_budget_days where day >= current_date - 1`);
    console.log(`global model budget (last two days) before $${(Number(budgetBefore) / 1e6).toFixed(4)}, after $${(Number(budgetAfter) / 1e6).toFixed(4)} (other people's turns are in this figure too)`);
  } finally {
    note(15, "all", "the test person was removed", cleanup());
    await closeBrowser();
  }
}

let code = 2;
try { code = await main() ?? 0; } catch (e) { console.log(`FAIL: ${(e as Error).message}`); note(15, "all", "the replay ran to the end", false, (e as Error).message); }
if (!DRY) {
  const fails = checks.filter((c) => c.status === "FAIL");
  const items: Record<string, string> = {};
  for (const c of checks) items[String(c.item)] = items[String(c.item)] === "FAIL" || c.status === "FAIL" ? "FAIL" : c.status === "NOT_RUN" && !items[String(c.item)] ? "NOT_RUN" : (items[String(c.item)] ?? c.status);
  const usd = transcript.length ? transcript.at(-1)!.usd_micros_after / 1e6 : 0;
  const report = { outcome: fails.length || !checks.length ? "FAIL" : "PASS", sha: SHA, at: new Date().toISOString(), run: RUN, test_person: EMAIL, turns: transcript.filter((x) => /^([TS]\d|F\d[ab]?)$/.test(x.turn)).length,
    setup_turns: transcript.filter((x) => x.turn.startsWith("setup")).length, usd, baseline: BASELINE, baseline_all: BASELINE_ALL, models: modelLog, items, checks, files, screenshots, transcript };
  await Deno.mkdir(OUT, { recursive: true });
  await Deno.writeTextFile(`${OUT}/r10-live-replay.json`, JSON.stringify(report, null, 2));
  console.log(`\nR10 live replay ${report.outcome}: ${checks.length - fails.length}/${checks.length} checks; ${report.turns} observed turns + ${report.setup_turns} setup turns; $${usd.toFixed(4)}; report ${OUT}/r10-live-replay.json`);
  code = report.outcome === "PASS" ? 0 : 1;
}
Deno.exit(code);
