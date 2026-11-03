// Reads the JSON that scripts/launch/mass-apply-proof.sql printed (one file per phase) and prints PASS / FAIL / SKIP per proof rule
// of docs/architect/mass-apply-proof-runbook.md (sections B and D). It reads files only: no network, no database, no secrets.
//
//   deno run -A scripts/launch/mass-apply-proof-report.ts proof-1-before-search.json proof-2-after-search.json \
//        proof-3-after-apply.json proof-4-final.json
//   (a single file holding a JSON array of snapshots works too). Exit 0 only for PROVEN; 1 for anything else; 2 for unreadable input.
//
// The word "working" is printed in exactly one place: the PROVEN verdict. That verdict needs a career_apply_jobs row in the state
// 'confirmed' (the apply_status_summary word "submitted_confirmed") with the employer's reference (confirmation_id), the employer's own
// email matched by hash, and every earlier link of the chain (D, L1 and L2). A row 'submitted_unconfirmed' is "sent, unproven":
// a page's "thank you" is evidence, never confirmation (migration 20261021080000:496-498).

// deno-lint-ignore no-explicit-any
export type Json = Record<string, any>;
export type Status = "PASS" | "FAIL" | "SKIP";
export interface RuleResult { id: string; name: string; status: Status; detail: string }
export interface JobLine { id: string; company: string; state: string; label: string; missing: string[]; proven: boolean }
export interface Report { rules: RuleResult[]; jobs: JobLine[]; verdict: "PROVEN" | "NOT PROVEN"; headline: string; proven_job: string | null }

export const SCHEMA = "mass-apply-proof/1";
// career_apply_jobs.state check constraint (migration 20261020000001). 'submitted_confirmed' is the summary WORD for 'confirmed', never a stored state.
export const DB_STATES = ["queued", "driving", "confirmed", "submitted_unconfirmed", "needs_user", "failed", "not_submitted", "unknown_outcome"];
const SENT_STATES = ["submitted_unconfirmed", "confirmed"];
const NOT_SENT_STATES = ["needs_user", "failed", "not_submitted"];

const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const str = (v: unknown): string => (v == null ? "" : String(v));
const blank = (v: unknown): boolean => str(v).trim() === "";
const hex64 = (v: unknown): boolean => /^[a-f0-9]{64}$/.test(str(v));

// The employer's site, compared by its last two labels (boards.greenhouse.io and job-boards.greenhouse.io are one host family).
export function hostFamily(u: unknown): string {
  try { return new URL(str(u)).hostname.toLowerCase().split(".").slice(-2).join("."); } catch { return ""; }
}

export function parseSnapshots(texts: string[]): Json[] {
  const out: Json[] = [];
  for (const t of texts) {
    const i = t.search(/[\[{]/); // psql may print a leading tag line; the JSON starts at the first brace
    if (i < 0) throw new Error("no JSON found in input");
    let v: unknown;
    try { v = JSON.parse(t.slice(i)); } catch (e) { throw new Error(`input is not valid JSON: ${(e as Error).message}`); }
    for (const s of Array.isArray(v) ? v : [v]) {
      if (!s || typeof s !== "object" || (s as Json).schema !== SCHEMA) throw new Error(`input is not a ${SCHEMA} snapshot (scripts/launch/mass-apply-proof.sql)`);
      out.push(s as Json);
    }
  }
  if (!out.length) throw new Error("no snapshots given");
  const users = new Set(out.map((s) => str(s.user_id)));
  if (users.size > 1) throw new Error(`snapshots are for different people: ${[...users].join(", ")}`);
  return out;
}

const byPhase = (snaps: Json[], phase: string): Json | null => [...snaps].reverse().find((s) => s.phase === phase) ?? null;
// The snapshot the evidence is read from: the one labelled final, else the one taken last.
const latest = (snaps: Json[]): Json => byPhase(snaps, "final") ?? [...snaps].sort((a, b) => str(a.taken_at).localeCompare(str(b.taken_at))).at(-1)!;

// ------------------------------------------------------------------------------------------------ per-job evidence checks
// L1: the application was submitted by Trainee's cloud drive and the evidence of that exists (runbook D, L1).
export function submittedGaps(s: Json, j: Json): string[] {
  const miss: string[] = [];
  const id = str(j.id);
  const receipt = arr(s.receipts).find((r) => str(r.application_id) === id);
  const files = arr(s.receipt_files).filter((f) => str(f.application_id) === id);
  const after = files.find((f) => f.kind === "after-submit");
  const events = arr(s.cloud_events).filter((e) => str(e.job_id) === id && e.outcome === "submitted");
  const out = arr(s.outbox).find((o) => o.key === `receipt:${id}`);
  const status = num(j.http_status);
  if (j.source !== "cloud") miss.push("source is not 'cloud'");
  if (num(j.attempts) !== 1) miss.push("attempts is not 1");
  if (j.hashes_agree !== true) miss.push("payload_hash differs from approval_hash");
  if (!(status >= 200 && status < 400)) miss.push("no 2xx/3xx response status in the evidence");
  const dest = hostFamily(j.destination || j.final_url), post = hostFamily(j.url);
  if (!dest || dest !== post) miss.push("destination is not on the posting's employer host");
  if (!receipt) miss.push("no career_apply_receipts row");
  else {
    if (receipt.reached_employer !== "yes") miss.push("receipt does not say reached_employer = yes");
    if (blank(receipt.clicked_at)) miss.push("receipt has no clicked_at");
  }
  if (!after || after.bound !== true || !hex64(after.sha256)) miss.push("no bound after-submit file");
  else if (!JSON.stringify(j.shot_sha256 ?? null).includes(str(after.sha256))) miss.push("after-submit sha256 is not in the evidence's screenshots");
  if (events.length !== 1) miss.push(`cloud_events has ${events.length} 'submitted' rows, not 1`);
  if (!out || out.status !== "delivered" || out.has_provider_id !== true || blank(out.delivered_at)) miss.push("receipt text not delivered (outbox receipt:<job id>)");
  return miss;
}

// L2: confirmed means the employer's own email was matched (runbook D, L2); the page's thank-you never counts.
export function confirmedGaps(s: Json, j: Json): string[] {
  const miss: string[] = [];
  if (j.state !== "confirmed") miss.push("state is not 'confirmed'");
  if (blank(j.confirmation_id)) miss.push("no employer reference (confirmation_id)");
  if (blank(j.email_confirmed_at)) miss.push("email_confirmed_at is empty");
  if (!hex64(j.confirmation_mail_hash)) miss.push("confirmation_mail_hash is empty");
  const mail = arr(s.mail_events).find((m) => m.application_ref === `job:${str(j.id)}` && m.kind === "received" && m.flagged !== true && m.message_hash === j.confirmation_mail_hash);
  if (!mail) miss.push("no unflagged 'received' mail event whose message_hash equals confirmation_mail_hash");
  return miss;
}

function labelOf(j: Json, l1: string[], l2: string[]): string {
  const page = str(j.page_confirmation) === "true" ? "the page showed a thank-you" : "no page thank-you recorded";
  switch (j.state) {
    case "confirmed": return l1.length || l2.length ? "CLAIMS CONFIRMED BUT THE EVIDENCE IS INCOMPLETE: not accepted as proof" : `CONFIRMED by the employer's own email (employer reference ${str(j.confirmation_id)})`;
    case "submitted_unconfirmed": return `SUBMITTED, UNCONFIRMED: sent (${page}) but the employer's confirmation email is not matched; sent, unproven`;
    case "unknown_outcome": return "UNKNOWN OUTCOME: cannot tell whether it reached the employer; never re-sent";
    case "queued": case "driving": return "IN PROGRESS: approved, not finished; not proof of anything";
    case "needs_user": case "failed": case "not_submitted": return "NOT SENT: nothing reached the employer";
    default: return `UNRECOGNISED STATE '${str(j.state)}': not a career_apply_jobs state; not accepted`;
  }
}

// ------------------------------------------------------------------------------------------------ the rules
export function evaluate(snaps: Json[]): Report {
  const fin = latest(snaps);
  const jobs = arr(fin.jobs);
  const rules: RuleResult[] = [];
  const add = (id: string, name: string, status: Status, detail: string) => rules.push({ id, name, status, detail });

  // P1 preconditions (runbook A, F1): without these a Telegram Apply cannot reach the employer.
  {
    const first = byPhase(snaps, "before-search") ?? fin;
    const set = new Map(arr(first.settings).map((r) => [str(r.key), str(r.value)]));
    const bad: string[] = [];
    if (set.get("CAREER_CLOUD_TEXT_CARDS") !== "on") bad.push("career_cloud_settings CAREER_CLOUD_TEXT_CARDS is not 'on' (every claim would be cloud_switches_off)");
    if (set.get("CAREER_CLOUD_APPLY") !== "on") bad.push("career_cloud_settings CAREER_CLOUD_APPLY is not 'on'");
    if (first.optin?.enabled !== true) bad.push("the person's cloud opt-in is not enabled");
    if (!arr(first.waivers).some((w) => blank(w.revoked_at) && num(w.max_sends) >= 1)) bad.push("no live cloud gate waiver row");
    add("P1", "switches, opt-in and waiver are in place", bad.length ? "FAIL" : "PASS", bad.join("; ") || "CLOUD_APPLY and CLOUD_TEXT_CARDS on, opted in, a waiver row exists");
  }

  // S4 the search queued nothing (runbook B2/C1).
  {
    const b = byPhase(snaps, "before-search"), a = byPhase(snaps, "after-search");
    if (!b || !a) add("S4", "a search queued nothing", "SKIP", "needs a before-search and an after-search snapshot; this invariant is NOT shown");
    else {
      const dw = num(a.counts?.wanted) - num(b.counts?.wanted), dj = num(a.counts?.jobs) - num(b.counts?.jobs);
      add("S4", "a search queued nothing", dw === 0 && dj === 0 ? "PASS" : "FAIL",
        dw === 0 && dj === 0 ? `career_apply_wanted ${num(b.counts?.wanted)} -> ${num(a.counts?.wanted)}, career_apply_jobs ${num(b.counts?.jobs)} -> ${num(a.counts?.jobs)}` : `the search changed career_apply_wanted by ${dw} and career_apply_jobs by ${dj}`);
    }
  }

  // A1 one Apply tap on an unprepared role queues exactly one wanted row and no application (runbook B5/C2).
  {
    const a = byPhase(snaps, "after-search"), t = byPhase(snaps, "after-apply");
    if (!a || !t) add("A1", "one Apply tap queues one wanted row, no application", "SKIP", "needs after-search and after-apply snapshots");
    else {
      const dw = num(t.counts?.wanted) - num(a.counts?.wanted), dj = num(t.counts?.jobs) - num(a.counts?.jobs);
      const waiting = arr(t.wanted).some((w) => w.state === "waiting" || w.state === "taken");
      add("A1", "one Apply tap queues one wanted row, no application", dw === 1 && dj === 0 && waiting ? "PASS" : "FAIL",
        `career_apply_wanted +${dw} (want +1), career_apply_jobs +${dj} (want +0), a waiting/taken row ${waiting ? "present" : "absent"}`);
    }
  }

  // H1 the approval is bound to the prepared payload (runbook D L1: payload_hash = approval_hash = the card's hash).
  {
    if (!jobs.length) add("H1", "each application is bound to its prepared payload hash", "SKIP", "no career_apply_jobs row yet");
    else {
      const bad = jobs.filter((j) => j.hashes_agree !== true || !hex64(j.payload_hash) || !arr(fin.prepared).some((p) => str(p.job_id) === str(j.job_id) && p.payload_hash === j.payload_hash)).map((j) => str(j.id));
      add("H1", "each application is bound to its prepared payload hash", bad.length ? "FAIL" : "PASS", bad.length ? `hash mismatch or no matching prepared row: ${bad.join(", ")}` : `${jobs.length} application(s): payload_hash = approval_hash = prepared hash`);
    }
  }

  // Y1 a "yes" (or a tap) never queues more than the card it answered showed (batch counts).
  {
    const cards = arr(fin.batch?.cards_answered_since), items = cards.reduce((n, c) => n + num(c.items_n), 0);
    const byState = (fin.batch?.jobs_since_by_state ?? {}) as Json;
    const queued = Object.values(byState).reduce((n: number, v) => n + num(v), 0);
    if (!cards.length && !queued) add("Y1", "a yes queues only what its card showed", "SKIP", "no answered card and no application since the run began");
    else if (queued > items) add("Y1", "a yes queues only what its card showed", "FAIL", `${queued} application(s) were queued since the run began but the answered card(s) showed ${items} item(s)`);
    else add("Y1", "a yes queues only what its card showed", "PASS", `${queued} application(s) queued from ${cards.length} answered card(s) showing ${items} item(s)`);
  }

  // C1 nothing is sent twice (runbook E: attempts capped at 1, a dead drive is never re-sent).
  {
    if (!jobs.length) add("C1", "nothing is sent twice", "SKIP", "no career_apply_jobs row yet");
    else {
      const bad = jobs.filter((j) => num(j.attempts) > 1 || arr(fin.cloud_events).filter((e) => str(e.job_id) === str(j.id) && e.outcome === "submitted").length > 1).map((j) => str(j.id));
      add("C1", "nothing is sent twice", bad.length ? "FAIL" : "PASS", bad.length ? `more than one attempt or 'submitted' event: ${bad.join(", ")}` : "every application has at most one attempt and one 'submitted' event");
    }
  }

  // L1 every application that says it was submitted carries the evidence of it.
  const sent = jobs.filter((j) => SENT_STATES.includes(j.state));
  const l1 = new Map(sent.map((j) => [str(j.id), submittedGaps(fin, j)]));
  {
    const bad = [...l1].filter(([, m]) => m.length);
    if (!sent.length) add("L1", "a submitted application carries its evidence", "SKIP", "no application is submitted yet");
    else add("L1", "a submitted application carries its evidence", bad.length ? "FAIL" : "PASS", bad.length ? bad.map(([id, m]) => `${id}: ${m.join("; ")}`).join(" | ") : `${sent.length} submitted application(s) with receipt, bound screenshot, response and delivered receipt text`);
  }

  // L2 'confirmed' only with the employer's own email and the employer's reference.
  const conf = jobs.filter((j) => j.state === "confirmed");
  const l2 = new Map(conf.map((j) => [str(j.id), confirmedGaps(fin, j)]));
  {
    const bad = [...l2].filter(([, m]) => m.length);
    if (!conf.length) add("L2", "confirmed means the employer's email was matched", "SKIP", "no application is confirmed yet");
    else add("L2", "confirmed means the employer's email was matched", bad.length ? "FAIL" : "PASS", bad.length ? bad.map(([id, m]) => `${id}: ${m.join("; ")}`).join(" | ") : `${conf.length} confirmed application(s) with employer reference, email_confirmed_at and a matching received mail event`);
  }

  // U1 only real states; the summary word 'submitted_confirmed' is not one a row can hold.
  {
    const bad = jobs.filter((j) => !DB_STATES.includes(str(j.state))).map((j) => `${str(j.id)}='${str(j.state)}'`);
    add("U1", "every state is a real career_apply_jobs state", !jobs.length ? "SKIP" : bad.length ? "FAIL" : "PASS", !jobs.length ? "no career_apply_jobs row yet" : bad.length ? `unknown state: ${bad.join(", ")}` : "all states recognised");
  }

  // N1 a state that means "nothing was sent" has no receipt saying the employer was reached.
  {
    const nots = jobs.filter((j) => NOT_SENT_STATES.includes(j.state));
    if (!nots.length) add("N1", "a not-sent state never claims the employer was reached", "SKIP", "no needs_user / failed / not_submitted row");
    else {
      const bad = nots.filter((j) => arr(fin.receipts).some((r) => str(r.application_id) === str(j.id) && r.reached_employer === "yes")).map((j) => str(j.id));
      add("N1", "a not-sent state never claims the employer was reached", bad.length ? "FAIL" : "PASS", bad.length ? `receipt says reached_employer = yes on a not-sent row: ${bad.join(", ")}` : `${nots.length} not-sent row(s), none claims the employer was reached`);
    }
  }

  // ----------------------------------------------------------------------------------------------- per job and the verdict
  const lines: JobLine[] = jobs.map((j) => {
    const g1 = SENT_STATES.includes(j.state) ? l1.get(str(j.id)) ?? [] : [];
    const g2 = j.state === "confirmed" ? l2.get(str(j.id)) ?? [] : [];
    return { id: str(j.id), company: str(j.company), state: str(j.state), label: labelOf(j, g1, g2), missing: [...g1, ...g2], proven: j.state === "confirmed" && !g1.length && !g2.length };
  });
  const failed = rules.filter((r) => r.status === "FAIL");
  const s4 = rules.find((r) => r.id === "S4")!;
  const proved = lines.find((l) => l.proven) ?? null;
  let headline: string, verdict: Report["verdict"] = "NOT PROVEN";
  if (proved && !failed.length && s4.status === "PASS") {
    verdict = "PROVEN";
    headline = `The mass-apply path is working for ${lines.filter((l) => l.proven).length} application(s): ${proved.company} was submitted and then confirmed by the employer's own email (employer reference ${str(jobs.find((j) => str(j.id) === proved.id)?.confirmation_id)}). One confirmed application proves the path, not scale.`;
  } else if (failed.length) headline = `${failed.length} proof rule(s) failed: ${failed.map((r) => r.id).join(", ")}. Nothing is claimed.`;
  else if (proved && s4.status !== "PASS") headline = "A confirmed application exists but the 'a search queued nothing' check was not shown (S4 needs before-search and after-search snapshots). Not claimed.";
  else if (lines.some((l) => l.state === "submitted_unconfirmed")) headline = "SENT, UNPROVEN: at least one application was submitted but no employer confirmation (email plus employer reference) is on file. Wait for the employer's email and the mail run, then take a new final snapshot.";
  else if (lines.some((l) => l.state === "unknown_outcome")) headline = "UNKNOWN OUTCOME: the drive ended without a result Trainee can read. Check the owner's inbox and the employer's portal; this is not proof, and Trainee will not re-send.";
  else headline = "No application has reached an employer yet; there is nothing to prove.";
  return { rules, jobs: lines, verdict, headline, proven_job: proved?.id ?? null };
}

export function render(r: Report): string {
  const out: string[] = ["MASS-APPLY PROOF REPORT", ""];
  for (const x of r.rules) out.push(`${x.status.padEnd(4)}  ${x.id.padEnd(2)}  ${x.name}\n            ${x.detail}`);
  out.push("", "APPLICATIONS");
  if (!r.jobs.length) out.push("  none");
  for (const j of r.jobs) out.push(`  ${j.company || "(no name)"} [${j.state}] ${j.id}\n    ${j.label}${j.missing.length ? `\n    missing: ${j.missing.join("; ")}` : ""}`);
  out.push("", `VERDICT: ${r.verdict}`, r.headline);
  return out.join("\n");
}

if (import.meta.main) {
  const files = Deno.args.filter((a) => !a.startsWith("--"));
  if (!files.length) { console.error("usage: deno run -A scripts/launch/mass-apply-proof-report.ts <snapshot.json>..."); Deno.exit(2); }
  try {
    const report = evaluate(parseSnapshots(await Promise.all(files.map((f) => Deno.readTextFile(f)))));
    console.log(render(report));
    Deno.exit(report.verdict === "PROVEN" ? 0 : 1);
  } catch (e) { console.error(`mass-apply-proof-report: ${(e as Error).message}`); Deno.exit(2); }
}
