// REAL SET, item 12 (tracking: statuses read from real mail; VERIFICATION-15 "The 95% bars", D-068). The runner only: it waits for
// the owner's Gmail after the deploy. Nothing here has read any real mail.
//
//   export      the owner's own mail, read with the product's own reader (career_mail_gmail.ts readMailSince: gmail.readonly,
//               metadata and snippet only, sent mail and drafts left out). Needs TRACKING_REAL_SET_CONSENT=<the DECISIONS.md line
//               where the owner consents> and GMAIL_READ_TOKEN (an access token the owner gets for their own account with the
//               gmail.readonly scope, set in their own shell; never typed into chat, never committed). Writes, to a directory
//               OUTSIDE this repository (refused otherwise): mails.json (message hash, from, subject, snippet, date) and
//               labels.json, the same messages with an empty "expect" for the owner to fill: kind (received, rejection,
//               interview, assessment, offer, recruiter_reply or other) and company.
//   score       classifyMail (career_mail.ts, what the mail run uses) on the owner's labelled file, scored the way the synthetic
//               set is (evals/career/mail-eval.ts evaluate). Writes ONLY counts to results/ (precision, recall, per kind,
//               confusions, the employer agreement, and misses by message hash and kind): no sender, subject or snippet.
//               Bar: status precision >= 95% and recall >= 95% by exact count, and N >= 20 labelled status emails.
//   --self-test the score path on the SYNTHETIC set (evals/career/mail-labels.json): proves the runner at $0, is not the bar.
//
//   TRACKING_REAL_SET_CONSENT=D-0xx GMAIL_READ_TOKEN=... deno run -A --no-check evals/real-sets/tracking/run.ts export --since 2026-09-01 --out ~/trainee-mail-set
//   deno run -A --no-check evals/real-sets/tracking/run.ts score --labels ~/trainee-mail-set/labels.json
//   deno run -A --no-check evals/real-sets/tracking/run.ts --self-test
// No model, nothing sent.
// deno-lint-ignore-file no-explicit-any require-await
import { readMailSince } from "../../../supabase/functions/_shared/career_mail_gmail.ts";
import { evaluate } from "../../career/mail-eval.ts";

const HERE = new URL(".", import.meta.url).pathname, ROOT = new URL("../../../", import.meta.url).pathname;
const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const abs = (p: string) => p.startsWith("/") ? p : `${Deno.cwd()}/${p}`;
const inRepo = (p: string) => { const r = Deno.realPathSync(ROOT); try { return Deno.realPathSync(p).startsWith(r); } catch { return abs(p).startsWith(r) || abs(p).startsWith(ROOT); } };
const ratio = (x: number, y: number) => (y ? x / y : 1);

function scoreLine(label: string, r: ReturnType<typeof evaluate>) {
  const s = r.status, ok = s.precision >= 0.95 && s.recall >= 0.95 && s.labeled >= 20;
  return { ok, line: `${label}: messages ${r.total}, status emails labelled ${s.labeled}; precision ${Math.round(s.precision * s.predicted)}/${s.predicted} (${(100 * s.precision).toFixed(1)}%), recall ${Math.round(s.recall * s.labeled)}/${s.labeled} (${(100 * s.recall).toFixed(1)}%); employer right ${r.company.right}/${r.company.checked}; rejection read as interview ${r.confusions.rejection_as_interview}; ${ok ? "MEETS" : "BELOW"} (bar 95% precision and recall, N >= 20)` };
}

if (a.includes("--self-test")) {
  const set = JSON.parse(await Deno.readTextFile(`${ROOT}evals/career/mail-labels.json`));
  const r = evaluate(set.mails);
  console.log(scoreLine("TRACKING RUNNER SELF-TEST (synthetic mail-labels.json, not the bar)", r).line);
  Deno.exit(0);
}

if (a[0] === "export") {
  const consent = Deno.env.get("TRACKING_REAL_SET_CONSENT") ?? "", token = Deno.env.get("GMAIL_READ_TOKEN") ?? "", out = opt("--out"), since = Date.parse(opt("--since") ?? "");
  if (!/^D-\d{3}[a-z]?$/.test(consent)) { console.log("refused: reading real mail needs TRACKING_REAL_SET_CONSENT=<the DECISIONS.md line where the owner consents>"); Deno.exit(3); }
  if (!token) { console.log("refused: needs GMAIL_READ_TOKEN, the owner's own gmail.readonly access token, set in their shell"); Deno.exit(3); }
  if (!out || inRepo(out)) { console.log("refused: --out must be a directory outside this repository (real mail is never committed)"); Deno.exit(3); }
  if (!Number.isFinite(since)) { console.log("refused: --since YYYY-MM-DD"); Deno.exit(2); }
  const r = await readMailSince({ fetch, token: async () => token }, "owner-real-set", since, Date.now(), { maxMessages: 500, maxList: 2000 });
  if (r.status !== "ok") { console.log(`not read: ${r.status} ${(r as any).detail ?? (r as any).reason ?? ""}`); Deno.exit(1); }
  await Deno.mkdir(out, { recursive: true });
  const mails = r.mails.map((m) => ({ id: m.hash, from: m.from, subject: m.subject, snippet: m.snippet, date: m.date }));
  await Deno.writeTextFile(`${out}/mails.json`, JSON.stringify({ read_at: new Date().toISOString(), mails }, null, 1) + "\n");
  await Deno.writeTextFile(`${out}/labels.json`, JSON.stringify({ note: "Fill expect.kind (received, rejection, interview, assessment, offer, recruiter_reply, other) and expect.company for every message, without looking at what Trainee read.", mails: mails.map((m) => ({ ...m, expect: { kind: "", company: "" } })) }, null, 1) + "\n");
  console.log(`exported ${mails.length} messages (listed ${r.listed}) to ${out}; label labels.json, then: run.ts score --labels ${out}/labels.json`);
  Deno.exit(0);
}

if (a[0] === "score") {
  const p = opt("--labels");
  if (!p || inRepo(p)) { console.log("refused: --labels must be the owner's file outside this repository"); Deno.exit(3); }
  const set = JSON.parse(await Deno.readTextFile(p));
  const unlabelled = set.mails.filter((m: any) => !m.expect?.kind);
  if (unlabelled.length) { console.log(`refused: ${unlabelled.length} message(s) have no expect.kind yet`); Deno.exit(2); }
  const r = evaluate(set.mails);
  const { ok, line } = scoreLine("REAL-SET TRACKING (owner's labelled mail)", r);
  await Deno.mkdir(`${HERE}results`, { recursive: true });
  const counts = { at: new Date().toISOString(), line, total: r.total, status: r.status, kinds: r.kinds, company: r.company, confusions: r.confusions,
    misses: r.misses.map((m) => ({ id: m.id, want: m.want.startsWith("company ") ? "company" : m.want, got: m.got.startsWith("company ") ? "company" : m.got })), recall_check: ratio(r.status.recall * r.status.labeled, r.status.labeled) };
  await Deno.writeTextFile(`${HERE}results/latest.json`, JSON.stringify(counts, null, 1) + "\n");
  console.log(line);
  Deno.exit(ok ? 0 : 1);
}

console.log("usage: run.ts export --since YYYY-MM-DD --out <dir outside the repo> | score --labels <file outside the repo> | --self-test");
Deno.exit(2);
