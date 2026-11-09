// R10 (owner order 2026-11-09), WO-I fix 15: the POST-DEPLOY live replay. It sends the five observed user turns (spec A.2,
// tests/architect/helpers/r10_turns.ts) to the DEPLOYED agent-chat as a dedicated synthetic test person, through the same call
// the channels make (trainee-telegram -> chatThroughAgent: POST /functions/v1/agent-chat with the service key, as_user_id and
// channel "telegram"), captures every reply, downloads every delivered file (the reply's attachments by their owner-scoped ref,
// and every link it carries), opens each file (pages, text, target), fetches each File page and screenshots it at 390 px, and
// writes a report. Run ONLY by the owner or the architect, after a deploy, through .github/workflows/r10-live-replay.yml
// (workflow_dispatch). It is never part of the gate.
//
// THE TEST PERSON, and why it cannot reach a real employer or contact:
//   - Identity: a fresh Supabase Auth user per run, email r10-live-replay-<run>@users.trainee.invalid (".invalid" is reserved by
//     RFC 2606: no mail can ever be delivered to it), user_metadata { r10_live_replay: true, run }. Its only channel contact is
//     tg:<id> with id = 9_100_000_000 + (run mod 10^8), refused if that contact already exists. The contact exists only so the
//     File pages' Telegram sign-in maps to this person; no Telegram message is ever sent by this script (it never calls the Bot
//     API), and a bot can only message a user who has started it, which a synthetic id never has.
//   - Applications: the five turns say "don't apply"; the script sends no other words (no "yes", no approve, no tap). After every
//     turn it checks career_apply_wanted, career_apply_jobs, career_apply_cards, career_send_queue and career_outreach_drafts for
//     the test person; anything there is deleted at once (so no worker prepares or sends it) and reported as a FAIL. The person has
//     no cloud opt-in and no connected mailbox, so no rail can submit or send for it, even with an approval.
//   - Employer sites: the only outside requests are read-only GETs of the application links a reply shows (to record whether
//     each is live), with a 10 s timeout and an identifying user agent; nothing is posted to any employer.
//   - Spend: model calls are counted by the product's own counters (agent_turn_costs for the test person; the global ledger
//     model_budget_days before and after). The run stops before the next turn once the person's recorded spend reaches the cap
//     (R10_LIVE_USD_CAP, default and maximum $1.00). The per-person daily AI cap ($0.05) applies to the test person as to anyone.
//   - Cleanup: at the end (and on any failure) the test person is deleted (auth.users cascade, the channel contact, its storage
//     objects); --cleanup-stale also deletes any earlier r10-live-replay person older than an hour.
// Secrets: only those already in the Actions "production" environment: SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN (to read the
// project's service key from the Management API, never printed), SUPABASE_DB_URL (psql: setup reads, the checks and cleanup), and
// TELEGRAM_BOT_TOKEN (optional: signs the test person's Mini App sign-in for File pages; without it File pages are fetched signed
// out and their private content is reported NOT_RUN). No secret is printed or written to the report.
//
// Usage: deno run -A scripts/launch/r10-live-replay.ts --sha <deployed sha> [--out <dir>] [--usd-cap 1] [--cleanup-stale] [--dry-run]
//   --dry-run: prints what it would do (the person's identity, the turns, the checks) and touches nothing.
// Exit: 0 every live check PASS; 1 any FAIL; 2 could not run (a missing secret, the project unreachable).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { BASELINE, INTAKE_RESUME, OBSERVED_FAILURES, OLD_SEARCH, SCENARIOS } from "../../tests/architect/helpers/r10_turns.ts";
import { closeBrowser, inspectDocx, inspectPdf, renderPhone, saveFile } from "../../tests/architect/helpers/r10_inspect.ts";

const args = Deno.args;
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const SHA = opt("--sha") ?? Deno.env.get("R10_LIVE_SHA") ?? "unknown";
const OUT = opt("--out") ?? Deno.env.get("R10_EVIDENCE_DIR") ?? "artifacts/r10-live-replay";
const USD_CAP = Math.min(1, Number(opt("--usd-cap") ?? Deno.env.get("R10_LIVE_USD_CAP") ?? "1") || 1); // never above $1 a run
const DRY = args.includes("--dry-run");
const RUN = Deno.env.get("GITHUB_RUN_ID") ?? String(Date.now());
const TG_ID = 9_100_000_000 + (Number(RUN.replace(/\D/g, "").slice(-8)) || Date.now() % 100_000_000);
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

type Status = "PASS" | "FAIL" | "NOT_RUN";
interface Check { item: number; turn: string; check: string; status: Status; detail: string }
const checks: Check[] = [];
const files: string[] = [], screenshots: string[] = [];
const transcript: { turn: string; text: string; reply: string; artifacts: string[]; links: string[]; usd_micros_after: number; calls_after: number }[] = [];
const note = (item: number, turn: string, check: string, pass: boolean | null, detail = "") => {
  const status: Status = pass === null ? "NOT_RUN" : pass ? "PASS" : "FAIL";
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
  const turns = [...SCENARIOS.resume.map((x) => ({ ...x, scenario: "resume" })), ...SCENARIOS.search.map((x) => ({ ...x, scenario: "search" }))];
  if (DRY) {
    console.log("DRY RUN: nothing is created, sent or deleted.");
    console.log(`setup: create ${EMAIL}, contact tg:${TG_ID}; send the intake (pasted), "yes, that's my resume", "${OLD_SEARCH}"`);
    for (const t of turns) console.log(`turn ${t.id} (${t.scenario}): ${t.text}`);
    console.log("then: download every attachment and link, open each file, screenshot each File page at 390 px, check nothing was applied, delete the test person.");
    return 0;
  }
  const ref = need("SUPABASE_PROJECT_REF"), token = need("SUPABASE_ACCESS_TOKEN"), db = need("SUPABASE_DB_URL");
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
  const budgetBefore = psql(db, `select coalesce(sum(spent_micros), 0) from public.model_budget_days where day >= current_date - 1`);

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
    const say = async (text: string, id: string) => {
      const s = spent();
      if (s.usd >= USD_CAP * 1_000_000) throw new Error(`spend cap: $${(s.usd / 1e6).toFixed(4)} recorded for the test person, at or over $${USD_CAP}; stopping before ${id}`);
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
      return { status: r.status, reply, links, arts, inline };
    };
    // Setup: the intake (pasted: the original file is not available, as in the audit), confirmed, then the old search.
    await say(`ok here is my resume:\n${INTAKE_RESUME}`, "setup-intake");
    await say("yes, that's my resume", "setup-confirm");
    await say(OLD_SEARCH, "setup-old-list");

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
    };

    // Scenario 1: resume.
    for (const t of SCENARIOS.resume) {
      const r = await say(t.text, t.id);
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
      const r = await say(t.text, t.id);
      const d = await delivered(t.id, r);
      quality(t.id, r.reply);
      const items = r.reply.split("\n").filter((l) => /^\s*\d+[.)]\s/.test(l));
      const apply = d.pages.filter((p) => !p.isFile);
      note(5, t.id, "a numbered shortlist with application links, or a bounded explanation of the empty result", items.length > 0 ? apply.length > 0 : /(checked|searched|found) \d+|nearby|remote|wider/i.test(r.reply), `${items.length} listed; ${apply.length} links followed`);
      for (const p of apply) note(6, t.id, `application link answers (${new URL(p.link).host})`, p.status > 0 && p.status < 400, `HTTP ${p.status}`);
      if (/limit/i.test(r.reply)) note(7, t.id, "at the limit: reset in the person's time, not midnight UTC", !/midnight UTC/i.test(r.reply), r.reply.slice(-200));
      for (const p of d.pages) if (p.isFile) note(5, t.id, `File page fits 390 px${p.signedIn ? " (signed in)" : " (signed out: no TELEGRAM_BOT_TOKEN)"}`, p.fits);
    }
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
    const s = spent();
    note(15, "all", `spend within $${USD_CAP} (recorded by agent_turn_costs)`, s.usd < USD_CAP * 1_000_000, `$${(s.usd / 1e6).toFixed(4)} over ${s.calls} model calls`);
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
  const report = { outcome: fails.length || !checks.length ? "FAIL" : "PASS", sha: SHA, at: new Date().toISOString(), run: RUN, test_person: EMAIL, turns: transcript.filter((x) => /^[TS]\d$/.test(x.turn)).length,
    setup_turns: transcript.filter((x) => x.turn.startsWith("setup")).length, usd, baseline: BASELINE, items, checks, files, screenshots, transcript };
  await Deno.mkdir(OUT, { recursive: true });
  await Deno.writeTextFile(`${OUT}/r10-live-replay.json`, JSON.stringify(report, null, 2));
  console.log(`\nR10 live replay ${report.outcome}: ${checks.length - fails.length}/${checks.length} checks; ${report.turns} observed turns + ${report.setup_turns} setup turns; $${usd.toFixed(4)}; report ${OUT}/r10-live-replay.json`);
  code = report.outcome === "PASS" ? 0 : 1;
}
Deno.exit(code);
