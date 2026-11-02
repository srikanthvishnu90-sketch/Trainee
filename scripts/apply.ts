// Terminal apply path. Candidate answers must be facts the owner gave, as the second judge's contract (WO-102) keeps
// them: {user_id, answers:{email:{value,factId,confirmed:true,provenance:"owner stated ...",confirmation_event_id}},
// saved:{normalized_label:...}, text_answers:[{id,key,kind,answer}]} (extension/src/apply_core.ts trustedManifest).
// Default: dry-run. Real submission requires --submit and the exact word yes.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  admitApplication,
  classifyField,
  normLabel,
  outcomeAfterSend,
  planBatch,
  questionFieldType,
} from "../supabase/functions/_shared/career_apply.ts";
import { hashApplyPayload } from "../supabase/functions/_shared/career_apply_store.ts";
import { pageRefusal } from "../workers/career-browser/mass-run.ts";
// How a form's fields become the planner's questions; shared with the browser extension (WO-031).
import { bindFields as bind } from "./career/form-bind.ts";
import { aiPolicyStatements } from "../supabase/functions/_shared/ai_policy.ts";
import {
  type Ats,
  ATS_NAMES,
  codeStop,
  EmailCode,
  fetchVerificationCode,
  gmailCodeMailbox,
  isAts,
  redactCode,
} from "../supabase/functions/_shared/career_email_code.ts";
import { CODE_MAX_WAIT_MS, pollForCode } from "../supabase/functions/_shared/career_email_code_poll.ts";
// WO-102: the submission-quality contract, the extension's own functions (never copied): which facts may be sent at all
// (trustedManifest), and which planned answers they stand behind (contractFill).
import { contractFill, isIdentityField, type Manifest, trustedManifest } from "../extension/src/apply_core.ts";
import { rowQuestionLabel, rowQuestionType } from "../supabase/functions/_shared/row_answer.ts";
import {
  bodyContents,
  bodyShape,
  carriesApproved as verifyCarries,
  type Endpoint,
  formOf,
  isScriptFamily,
  isSubmitEndpoint,
  scriptSubmitEndpoint,
} from "./career/request-verifier.ts";
const require = createRequire(import.meta.url);
const { hostAllowed } = require("../packages/domain/150-career-portal-browser.js");
const { createFileTaskStore } = require("../workers/career-browser/store.cjs");
const { readOnly } = require("./career/render-form.cjs");
const { fnPostingLocation } = require("./career/page-functions.cjs");
const sha = (b: any) => crypto.createHash("sha256").update(b).digest("hex");
// A confirmed answer for a single checkbox: "Yes" checks it as surely as "true" does.
const yesish = (v: unknown) => /^(true|yes|y|on|checked)$/i.test(String(v ?? "").trim());
// A form asking for an identity number stops before anything is filled: those are the person's to type, never held or
// sent by Trainee (standing rule: no full ID numbers anywhere). Round 2 of the apply scenarios (2026-10-30): the engine's
// own list missed the numbers of other countries and the ways forms write them ("Social Insurance Number (SIN)", "CURP",
// "Identity card no.", "Government-issued ID number", "Tax File Number (TFN)"), so the form was planned and the question
// went to the person by text. One list now, the extension's (extension/src/apply_core.ts isIdentityField, NEVER_BY_TEXT
// beside it), on the field's label and its name.
const IDENTITY_NUMBER = { test: (labelOrName: string) => isIdentityField({ label: labelOrName }) };
// A hidden field the employer's page sets is sent as it is and shown in the review, unless it consents to something on
// the person's behalf: a consent-like name with any value but a decline ("0", "false", "no", empty) stops.
const consentOnBehalf = (name: string, value: string) =>
  /consent|agree|terms|opt.?in|marketing|subscribe|newsletter|privacy/i.test(name) &&
  !/^(0|false|no|off|)$/i.test(String(value).trim());
const fail = (code: string) => Object.assign(Error(code), { code });
// The employer's answer to the one POST: a 2xx, or a redirect (303 to a thank-you page is the usual pattern). A redirect
// off the employer's own site never gets here: the route refuses it and the run stops.
const acknowledged = (status: number) => status >= 200 && status < 400;
// The verification a page runs (reCAPTCHA, including the invisible Enterprise check every captured Greenhouse and
// Ashby form loads; hCaptcha, which every captured Lever form loads; Turnstile) talks to its own provider at load, at
// the person's click and at submit. Those requests are the provider's and carry none of the person's answers, so they
// go through, only on these hosts and paths and never as a page navigation. Trainee never solves a check: the person
// does, in the window (--handoff), or the invisible check runs as it would for them.
const CAPTCHA_PROVIDER =
  /^https:\/\/((www\.)?(google\.com|recaptcha\.net|gstatic\.com)\/recaptcha\/|([a-z0-9-]+\.)*hcaptcha\.com\/|challenges\.cloudflare\.com\/)/;
// The token a passed check leaves in the form. It is the provider's, not an answer: it may be present in the hidden
// fields and the body, it is sent as the page set it, and only its length is recorded.
const CAPTCHA_TOKEN = /^(g-recaptcha-response|h-captcha-response|cf-turnstile-response)$/;
// The shape of a request body (keys, never values), what it carries, and whether it carries exactly the approved
// answers: one verifier for every hand that sends an application (scripts/career/request-verifier.ts).
function privateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) throw fail("PRIVATE_DIRECTORY_REQUIRED");
}
// Cloud-only one-shot IPC. The worker owns all credentials and chooses the captured job/lease; this channel
// can request only before_effect, never an RPC, URL, identity or hash. The browser receives none of it.
export function cloudEffectAuthorization(nonce: string, timeoutMs = 5000): () => Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw fail("CARD_CLOUD_AUTH_PROTOCOL");
  let requested = false;
  return async () => {
    if (requested) throw fail("CARD_CLOUD_AUTH_PROTOCOL");
    requested = true;
    const reader = Deno.stdin.readable.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = "CLOUD_AUTH " + JSON.stringify({ v: 1, nonce, phase: "before_effect" }) + "\n";
      const bytes = new TextEncoder().encode(request);
      let written = 0;
      while (written < bytes.length) written += await Deno.stdout.write(bytes.subarray(written));
      const read = async () => {
        let input = "";
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw fail("CARD_CLOUD_AUTH_PROTOCOL");
          input += decoder.decode(chunk.value, { stream: true });
          if (input.length > 1024) throw fail("CARD_CLOUD_AUTH_PROTOCOL");
          if (!input.includes("\n")) continue;
          if (!input.endsWith("\n") || input.indexOf("\n") !== input.length - 1 || !input.startsWith("CLOUD_AUTH "))
            throw fail("CARD_CLOUD_AUTH_PROTOCOL");
          let response;
          try { response = JSON.parse(input.slice(11, -1)); } catch { throw fail("CARD_CLOUD_AUTH_PROTOCOL"); }
          if (!response || Object.keys(response).sort().join(",") !== "allow,nonce,v" || response.v !== 1 ||
            response.nonce !== nonce || typeof response.allow !== "boolean") throw fail("CARD_CLOUD_AUTH_PROTOCOL");
          if (!response.allow) throw fail("CARD_CLOUD_AUTH_REFUSED");
          return;
        }
      };
      await Promise.race([read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(fail("CARD_CLOUD_AUTH_TIMEOUT")), timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
}

function options(args: string[]) {
  const o: any = { submit: false };
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k === "--submit") o.submit = true;
    else if (k === "--cloud-authorize-stdio") o["cloud-authorize-stdio"] = true;
    else if (k === "--cloud-authorize-nonce" && /^[0-9a-f]{64}$/.test(args[i + 1] || "")) o["cloud-authorize-nonce"] = args[++i];
    else if (k === "--dry-run") o.dry = true;
    // --handoff: when a verification shows on the page, wait for the person to complete it, then go on from the same
    // page. --headed opens a visible browser for the person's own runs (and implies --handoff).
    else if (k === "--handoff") o.handoff = true;
    else if (k === "--headed") o.headed = o.handoff = true;
    // --person-submits: Trainee fills, reads back and shows the review; the person presses Submit in the window. For
    // forms that submit from a script (Greenhouse job-boards, Ashby), whose request is not a bound form post. Exactly one
    // request goes through, only if it carries the approved answers, and its shape (keys, never values) is recorded.
    else if (k === "--person-submits") o["person-submits"] = true;
    // --script-submit greenhouse|ashby|lever: a local test page standing in for that family's script-submitted form. Trainee
    // clicks the employer's own Submit and the route binds where the approved answers go (scriptSubmitEndpoint): exactly
    // one request to that family's own application endpoint, only with exactly the approved answers; every other write
    // is stopped. For a real employer the family comes from the posting's host, and the binding is on only where the
    // owner switched it on (UPMORE_SCRIPT_SUBMIT_LIVE=1).
    else if (k === "--script-submit" && isScriptFamily(args[i + 1])) o["script-submit"] = args[++i];
    // --application-id <uuid>: the queue's application this approved run drives (career_apply_jobs.id); the proof is
    // bound to it (D-024). A canonical uuid only.
    else if (k === "--application-id" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args[i + 1] || "")) {
      o["application-id"] = args[++i];
    }
    // --approved <hash>: the person already approved this exact application (the approval hash a dry run printed, or
    // a texted yes on its card). The run fills and reads back as always and submits without asking again only if the
    // application is still exactly the one approved; any difference stops it with nothing sent.
    else if (k === "--approved" && /^[0-9a-f]{64}$/.test(args[i + 1] || "")) o.approved = args[++i];
    // --email-code account|local-gmail (WO-096): when the employer emails a code after the approved submit, Trainee reads
    // it from the person's own Gmail (read-only) and types it into the page. account: through the career-email-code
    // function, signed in as the person, for the queue row being driven (UPMORE_SUPABASE_URL, UPMORE_SUPABASE_ANON_KEY,
    // UPMORE_ACCESS_TOKEN, UPMORE_APPLY_JOB_ID, UPMORE_APPLY_LEASE). local-gmail: a loopback stand-in for Gmail's API
    // (UPMORE_GMAIL_TEST_API), for the local test pages only.
    else if (k === "--email-code" && ["account", "local-gmail"].includes(args[i + 1] || "")) o["email-code"] = args[++i];
    else if (
      ["--url", "--facts", "--resume", "--state-dir", "--evidence-dir"].includes(k) && args[i + 1] &&
      !args[i + 1].startsWith("--")
    ) o[k.slice(2)] = args[++i];
    else throw fail("INVALID_ARGUMENTS");
  }
  if (!o.url || !o.facts || !o.resume || (o.submit && o.dry)) {
    throw fail(
      "USAGE: deno run -A scripts/apply.ts --url <posting> --facts <confirmed-facts.json> --resume <file.pdf> [--submit]",
    );
  }
  return o;
}
function posting(u: URL) {
  const g = hostAllowed(u.href);
  if (
    !g.allowed || u.username || u.password || !["http:", "https:"].includes(u.protocol) ||
    (g.kind !== "local_test" && u.protocol !== "https:")
  ) throw fail("DRIVER_HOST_REFUSED");
  const segments = u.pathname.split("/").filter(Boolean), tenant = u.searchParams.get("for") || segments[0] || "";
  const id = g.atsFamily === "greenhouse"
    ? (u.pathname.match(/\/jobs\/(\d+)/)?.[1] || u.searchParams.get("token"))
    : g.atsFamily === "smartrecruiters"
    ? segments[1]?.match(/^\d+/)?.[0]
    : segments[1];
  if (g.kind !== "local_test" && (!tenant || !id)) throw fail("POSTING_ID_REQUIRED");
  return {
    key: g.kind === "local_test" ? u.origin + u.pathname : `${g.atsFamily}:${tenant}:${id}`,
    employer: g.kind === "local_test" ? u.host : u.host + "/" + tenant,
    local: g.kind === "local_test",
    tenant,
  };
}
// WO-102 (every path): the facts this run may send, by the extension's positive allowlist (trustedManifest): confirmed,
// the owner's own, a positive provenance ("owner stated ..."), the event that confirmed it, not quarantined (D-007:
// F-027..F-079 and the answer-all delegation), no id reserved for another source, not derived from anything excluded.
// A confirmed:true label alone is not enough. His texted answers (text_answers, career_apply_answers_own rows) are his;
// one that disagrees with the file excludes both, so the question is asked again. Another person's fact or answer stops.
export function trustedFacts(facts: any, artifact: { sha256: string }): Manifest {
  const owner = facts?.user_id;
  for (const t of ["answers", "saved"]) {
    for (const a of Object.values(facts?.[t] || {}) as any[]) if (a?.user_id && a.user_id !== owner) throw fail("FACT_OWNER_MISMATCH");
  }
  const rows = Array.isArray(facts?.text_answers) ? facts.text_answers : [];
  for (const r of rows) if (r?.user_id && r.user_id !== owner) throw fail("FACT_OWNER_MISMATCH");
  return trustedManifest({ owner, file: facts, rows, resume: { sha256: artifact.sha256 } });
}
// One step's plan: the planner on the trusted facts only, then the contract on what it would send (contractFill): an
// answer it cannot stand behind on a required question is asked (nothing is sent), on an optional one left empty; an
// attestation or a personal choice goes only on the owner's own answer to it.
export function planApplication(o: {
  manifest: Manifest; userId: string; jobId: string; employer: string; location?: string; schema: any[];
  artifact: { filename: string; sha256: string }; now: number;
}): { ready: true; fields: any[]; dropped: string[] } | { ready: false; needs: { label: string; why?: string; field_name?: string }[] } {
  const p = planBatch({
    userId: o.userId,
    postings: [{ job_id: o.jobId, company: o.employer, title: "", fields: o.schema, location: o.location }],
    answers: o.manifest.answers,
    saved: o.manifest.saved,
    log: [],
    now: o.now,
  });
  if (!p.ready.length) return { ready: false, needs: p.needs.map((n: any) => ({ label: n.label, ...(n.field_name ? { field_name: n.field_name } : {}) })) };
  const c = contractFill({
    schema: o.schema, manifest: o.manifest, resume: o.artifact, jobId: o.jobId,
    plan: { fill: p.ready[0].fields, needs: [], identity: [], ambiguous: [] },
  });
  if (c.asks.length) return { ready: false, needs: c.asks.map((a) => ({ label: a.label, why: a.why, ...(a.field_name ? { field_name: a.field_name } : {}) })) };
  return { ready: true, fields: c.fill, dropped: c.dropped };
}
// What the approval binds beside the answers (WO-102): each answer's fact, the event that confirmed it, its provenance,
// whether it may attest, and the quarantine rules it was judged under. Any change is another application.
export function approvalSources(fields: { name: string; factId: string }[], m: Manifest) {
  return fields.map((f) => {
    const tf = m.byFactId[f.factId];
    if (!tf) throw fail("UNTRUSTED_ANSWER: " + f.name);
    return { name: f.name, factId: f.factId, event: tf.event, provenance: tf.provenance, authorizes: tf.authorizes, quarantine_version: m.version,
      table: tf.table, key: tf.key, value: tf.value };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
export async function applicationApprovalHash(o: {
  userId: string; posting: string; destination: string; fields: any[]; resumeSha256: string; schemaHash: string;
  pageFieldNames: string[]; manifest: Manifest;
}) {
  return await hashApplyPayload({ user_id: o.userId, posting: o.posting, destination: o.destination,
    fields: o.fields.map((f) => ({ name: f.name, label: f.label, value: f.value, factId: f.factId })), resume: o.resumeSha256,
    schema_hash: o.schemaHash, page_field_names: o.pageFieldNames, manifest_hash: o.manifest.hash,
    sources: approvalSources(o.fields, o.manifest) });
}
const trustRecord = (m: Manifest) => ({
  quarantine_version: m.version, manifest_hash: m.hash, excluded: m.excluded.slice(0, 200), conflicts: m.conflicts.slice(0, 200),
});
async function answer() {
  const b = new Uint8Array(128);
  let s = "";
  while (s.length < 128) {
    const n = await Deno.stdin.read(b);
    if (n === null) break;
    s += new TextDecoder().decode(b.subarray(0, n));
    if (s.includes("\n")) break;
  }
  return s.split("\n")[0].replace(/\r$/, "");
}
// WO-096: where the emailed code is read from, or null when the run was not asked to read it. The result carries the code
// only inside an EmailCode (it prints as "[emailed code]"); a stop says what the person does instead.
type CodeRead = { status: string; code?: EmailCode; stop?: string };
type CodeReader = (i: { ats: Ats; sinceMs: number }) => Promise<CodeRead>;
function codeReader(mode: string | undefined, local: boolean, userId: string): CodeReader | null {
  if (!mode) return null;
  const env = (k: string) => Deno.env.get(k) || "";
  // A shorter wait, for the local test pages only; never longer than about three minutes.
  const wait = local && Number(env("UPMORE_EMAIL_CODE_WAIT_MS")) >= 0 && env("UPMORE_EMAIL_CODE_WAIT_MS") !== ""
    ? Math.min(Number(env("UPMORE_EMAIL_CODE_WAIT_MS")), CODE_MAX_WAIT_MS)
    : CODE_MAX_WAIT_MS;
  if (mode === "local-gmail") {
    const base = env("UPMORE_GMAIL_TEST_API");
    if (!local || !/^http:\/\/127\.\d+\.\d+\.\d+:\d+\//.test(base)) throw fail("LOCAL_GMAIL_LOCAL_ONLY");
    return async ({ ats, sinceMs }) => {
      const r = await fetchVerificationCode({ userId, ats, sinceMs, maxWaitMs: wait }, {
        mailbox: async () => gmailCodeMailbox({ fetch, token: "TEST-LOCAL-ONLY", base }),
        now: Date.now,
      });
      return r.status === "found" ? { status: r.status, code: r.code } : { status: r.status, stop: codeStop(r.status, ats) };
    };
  }
  const [url, anon, access, job, lease] = [
    "UPMORE_SUPABASE_URL",
    "UPMORE_SUPABASE_ANON_KEY",
    "UPMORE_ACCESS_TOKEN",
    "UPMORE_APPLY_JOB_ID",
    "UPMORE_APPLY_LEASE",
  ].map(env);
  if (!/^https:\/\//.test(url) || !anon || !access || !job || !lease) throw fail("EMAIL_CODE_NEEDS_SIGN_IN");
  return ({ ats, sinceMs }) =>
    pollForCode<CodeRead>(async () => {
      let r: Response;
      try {
        r = await fetch(url.replace(/\/$/, "") + "/functions/v1/career-email-code", {
          method: "POST",
          headers: { apikey: anon, authorization: "Bearer " + access, "content-type": "application/json" },
          body: JSON.stringify({ apply_id: job, lease, since_ms: sinceMs, ats }),
        });
      } catch {
        return { status: "not_yet" };
      }
      if (r.status === 401 || r.status === 403) {
        return { status: "refused", stop: "Type the code the employer emailed you on the page yourself." };
      }
      const body = await r.json().catch(() => null);
      if (!r.ok || !body) return { status: "not_yet" };
      if (body.status === "found" && typeof body.code === "string" && body.code) {
        return { status: "found", code: new EmailCode(body.code) };
      }
      return { status: String(body.status), stop: String(body.stop || codeStop("not_yet", ats)) };
    }, { now: Date.now, maxWaitMs: wait });
}
// Which family's script-submitted application this run may bind (null: none, and a form with no bound form post stops at
// SUBMIT_DESTINATION_NOT_BOUND). A local test page names the family it stands in for (--script-submit); a real posting
// is its host's family, only with --script-submit naming it or the owner's switch UPMORE_SCRIPT_SUBMIT_LIVE=1 on the host
// the engine runs on. Every real Ashby form (Ramp's included) has no <form> post, so without one of the two even the dry
// run that prepares the card stops there. The person's own Submit binds nothing here.
export function scriptSubmitFamily(o: { local: boolean; flag: string | null; live: boolean; family: unknown; personSubmits: boolean }) {
  if (o.personSubmits) return null;
  if (o.local) return isScriptFamily(o.flag) ? o.flag : null;
  return (o.flag || o.live) && isScriptFamily(o.family) ? o.family : null;
}
export async function runApply(args: string[]) {
  const o = options(args);
  if ((o["cloud-authorize-stdio"] || o["cloud-authorize-nonce"]) &&
    (!o["cloud-authorize-stdio"] || !o["cloud-authorize-nonce"] || !o.submit || !o.approved || o["person-submits"] || o.handoff))
    throw fail("CARD_CLOUD_AUTH_REQUIRED");
  const authorizeCloudEffect = o["cloud-authorize-stdio"] ? cloudEffectAuthorization(o["cloud-authorize-nonce"]) : null;
  const u = new URL(o.url),
    target = posting(u),
    _local = (() => {
      // Another state folder would be another once-only record: for a real employer there is exactly one.
      if (o["state-dir"] && !target.local) throw fail("STATE_DIR_LOCAL_ONLY");
      // A hand-off asks the person to complete a check in the browser window; a headless run has no window to use.
      if (o.handoff && !o.headed && !target.local) throw fail("HANDOFF_NEEDS_HEADED");
      if (o["person-submits"] && !o.headed && !target.local) throw fail("PERSON_SUBMITS_NEEDS_HEADED");
      if (o["script-submit"] && o["person-submits"]) throw fail("INVALID_ARGUMENTS");
      if (o["script-submit"] && !target.local && o["script-submit"] !== hostAllowed(u.href).atsFamily) {
        throw fail("SCRIPT_SUBMIT_FAMILY_MISMATCH");
      }
      // The loopback stand-in for Gmail is for the local test pages; a real employer's code comes from the real mailbox.
      if (o["email-code"] === "local-gmail" && !target.local) throw fail("LOCAL_GMAIL_LOCAL_ONLY");
    })(),
    factsBytes = fs.readFileSync(o.facts),
    factsHash = sha(factsBytes),
    facts = JSON.parse(factsBytes.toString());
  if (typeof facts.user_id !== "string" || !facts.user_id || facts.user_id.length > 160) {
    throw fail("CONFIRMED_FACT_OWNER_REQUIRED");
  }
  if (facts.paused === true) throw fail("ACCOUNT_PAUSED");
  if (facts.erased === true) throw fail("FACTS_ERASED");
  if (
    facts.expires_at !== undefined &&
    (!Number.isFinite(Date.parse(facts.expires_at)) || Date.parse(facts.expires_at) <= Date.now())
  ) throw fail("FACTS_EXPIRED");
  if (!target.local && (facts.synthetic === true || /^TEST[-_]/.test(facts.user_id))) {
    throw fail("SYNTHETIC_FACTS_REQUIRE_LOCAL_FIXTURE");
  }
  if (facts.posting?.url && posting(new URL(facts.posting.url)).key !== target.key) {
    throw fail("POSTING_BINDING_MISMATCH");
  }
  const company = typeof facts.posting?.company === "string" && facts.posting.company.trim()
    ? facts.posting.company
    : (target.local ? target.employer : target.tenant);
  // WO-096: the emailed code's reader (null unless --email-code), and whose senders it reads: the posting's own
  // application system (a local test page stands for Greenhouse).
  const readCode = codeReader(o["email-code"], target.local, facts.user_id);
  const family = hostAllowed(u.href).atsFamily;
  const codeAts: Ats | null = isAts(family) ? family : target.local ? "greenhouse" : null;
  const stateDir = o["state-dir"] || path.join(os.homedir(), ".local", "state", "upmore", "apply");
  privateDir(stateDir);
  const store = createFileTaskStore(stateDir),
    id = sha(facts.user_id + "\n" + target.key).slice(0, 32),
    ownerLock = sha("owner:" + facts.user_id).slice(0, 32);
  const existing = store.get(id);
  // "not_sent": the engine refused the submit before anything left the browser, so the posting may be tried again.
  if (existing && existing.state !== "not_sent") {
    if (existing.user_id !== facts.user_id || existing.job_id !== target.key) throw fail("STATE_BINDING_MISMATCH");
    try {
      const e = JSON.parse(fs.readFileSync(path.join(existing.evidence_path, "evidence.json"), "utf8")),
        obs = e.observation;
      const observed = obs && ["form_present_after", "captcha", "email_code_prompt"].every((k) =>
        typeof obs[k] === "boolean"
      ) && ["url_before", "url_after", "page_text"].every((k) => typeof obs[k] === "string") &&
        Number.isSafeInteger(obs.required_empty_after) && obs.required_empty_after >= 0 &&
        Array.isArray(obs.validation_errors) && obs.validation_errors.every((v: any) => typeof v === "string");
      if (
        e.payload?.user_id === facts.user_id && e.payload?.posting === target.key &&
        e.payload_hash === existing.payload_hash && await hashApplyPayload(e.payload) === existing.approval_hash &&
        e.post?.destination === e.payload.destination && e.post?.mutations === 1 && acknowledged(e.post.status) &&
        observed
      ) {
        const result = outcomeAfterSend(obs);
        store.withLock(id, () => store.put({ ...store.get(id), state: result.state, result }));
        return { ...result, already_recorded: true, evidence_path: existing.evidence_path };
      }
    } catch { /* Missing/partial evidence cannot create confirmation or permit a resend. */ }
    return {
      state: "unknown_outcome",
      reason: "READBACK_REQUIRED",
      already_recorded: true,
      evidence_path: existing.evidence_path || null,
    };
  }
  const artifact = { filename: path.basename(o.resume), sha256: sha(fs.readFileSync(o.resume)) },
    manifest = trustedFacts(facts, artifact);
  const evidenceDir = o["evidence-dir"] || fs.mkdtempSync(path.join(stateDir, "evidence-"));
  privateDir(evidenceDir);
  if (fs.readdirSync(evidenceDir).length) throw fail("EVIDENCE_DIRECTORY_NOT_EMPTY");
  const evidence: any = { posting: target.key, fields: [], readback: {}, payload: null };
  let session: any,
    page: any,
    fenced = false,
    denied = false,
    allowSubmit = false,
    populated = false,
    mutations = 0,
    postStatus = 0,
    destination = "",
    current: any,
    version = "";
  const authorizeEffect = async (route: any) => {
    if (!authorizeCloudEffect) return true;
    try { await authorizeCloudEffect(); return true; }
    catch (e: any) {
      evidence.transport_rejection = e?.code || "CARD_CLOUD_AUTH_REFUSED";
      await route.abort("blockedbyclient");
      return false;
    }
  };
  const wire: any = {};
  const personSubmits = !!o["person-submits"];
  // Script submit binding: where a script-submitted form's one application request may go. A local test page names the
  // family it stands in for; a real posting's family is its host's, and only with the owner's switch.
  const scriptFamily = scriptSubmitFamily({ local: target.local, flag: o["script-submit"] ?? null,
    live: Deno.env.get("UPMORE_SCRIPT_SUBMIT_LIVE") === "1", family, personSubmits });
  const scriptEndpoint: Endpoint | null = scriptFamily ? scriptSubmitEndpoint(scriptFamily, u, target.local) : null;
  // Every write stopped while the agent's submit was open (keys never kept, only where it went and why).
  const stopped: { method: string; url: string; why: string }[] = [];
  // Set at the final review: this form has no bound form post, so its one request is bound at the route instead. A form
  // whose own form post is bound keeps the stricter field-by-field form check below, whatever its family.
  let scripted = false;
  // Resume uploads the page made while filling an approved application, and the employer's answers to them.
  let resumeUploads = 0;
  const uploadEchoes: string[] = [];
  const echoed = (v: string) => v.length >= 4 && uploadEchoes.some((t) => t.includes(v));
  // The verification code the employer emails after the submit is the person's: they type it into the page and press
  // its button themselves. While the window is open, one write per try goes to the employer's own site (codeAllowance);
  // only its keys are kept. Trainee never reads, stores or logs the code.
  let codeWindow = false, codeAllowance = 0, codeWrites = 0;
  // WO-096: the code read from the person's mail, while this run holds it (memory only). Every record this run writes
  // and the result it prints are cleaned of it (redactCode), whatever an employer's page echoed back.
  let typedCode: EmailCode | null = null;
  // The employer's own hidden fields, as the page set them before anything was filled (name -> value).
  let pageFields: Record<string, string> | null = null;
  // D-024: each picture of the proof is taken into its own new file, numbered in this run's order, and recorded with
  // its hash, time and this run's and application's identity the moment it is taken. Nothing is read from a file
  // that was already there: an older picture, of this run or another, can never stand in for a new one.
  const runId = crypto.randomUUID();
  let proofSeq = 0;
  const capture = async (kind: string, extra: Record<string, unknown> = {}) => {
    const seq = ++proofSeq, file = path.join(evidenceDir, `proof-${seq}-${kind}.png`);
    if (fs.existsSync(file)) throw fail("PROOF_FILE_EXISTS");
    // Local test pages only: a picture that cannot be taken (proof-g6.test.ts).
    if (target.local && Deno.env.get("UPMORE_TEST_PROOF_FAULT") === kind) throw fail("PROOF_CAPTURE_FAILED");
    await send({ type: "screenshot", path: file });
    fs.chmodSync(file, 0o600);
    return Object.freeze({
      kind, file: path.basename(file), sha256: sha(fs.readFileSync(file)), seq, at: Date.now(),
      run_id: runId, application_id: o["application-id"] ?? null, ...extra,
    });
  };
  const write = (raw: any) => {
    const result = typedCode ? JSON.parse(redactCode(JSON.stringify(raw), typedCode)) : raw;
    evidence.result = result;
    // Every file of the evidence is the person's alone (0600), whichever step took it: the pictures, the record.
    for (const name of fs.readdirSync(evidenceDir)) {
      const file = path.join(evidenceDir, name);
      if (fs.lstatSync(file).isFile()) fs.chmodSync(file, 0o600);
    }
    const tmp = path.join(evidenceDir, crypto.randomUUID() + ".tmp"), fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, redactCode(JSON.stringify(evidence, null, 2), typedCode) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path.join(evidenceDir, "evidence.json"));
    const dir = fs.openSync(evidenceDir, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
    return { ...result, evidence_path: evidenceDir };
  };
  const send = (cmd: any) =>
    session.send({
      ...cmd,
      ...(["fill", "readback", "review", "verify_payload", "submit_and_capture"].includes(cmd.type)
        ? { observationVersion: version }
        : {}),
    });
  async function observe() {
    const r = await send({ type: "discover" });
    version = r.observation.version;
    const optionValues = await page.evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll("input,select,textarea")).map((e: any, i: number) => ({
        domIndex: i,
        name: e.name,
        id: e.id,
        value: ["radio", "checkbox"].includes(e.type) ? e.value : null,
      }))
    );
    for (const f of r.fields) {
      const opt = optionValues.find((a: any) => a.domIndex === f.domIndex && a.name === f.name && a.id === f.id);
      if (opt) f.optionValue = opt.value;
    }
    return { ...bind(r.fields), raw: r.fields, observation: r.observation };
  }
  function expected(field: any, b: any) {
    if (b.inputType === "file") return artifact;
    if (b.inputType === "checkbox") return yesish(field.value);
    const opt = b.options?.find((x: any) => x.value === field.value);
    return ["select", "radio_group"].includes(b.inputType) && opt ? opt.label : field.value;
  }
  function matches(a: any, b: any) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  async function unconfirmed(c: any, planned: any) {
    const all = await send({ type: "readback", bindings: Object.values(c.bindings) });
    for (const [name, value] of Object.entries(all.answers)) {
      const b = c.bindings[name],
        empty = value === false || b?.options?.some((x: any) => x.value === "" && x.label === value);
      if (!Object.hasOwn(planned, name) && !empty) throw fail("UNCONFIRMED_DEFAULT: " + name);
    }
    const hidden = await page.evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll("input,select,textarea")).filter((e: any) => {
        if (!e.name || e.disabled || e.type === "file" || e.type === "submit" || e.type === "button") return false;
        if (/^(g-recaptcha-response|h-captcha-response|cf-turnstile-response)$/.test(e.name)) return false;
        if (
          e.type === "hidden" &&
          /^(csrf(?:_token)?|authenticity_token|_token|utf8|job_?id|job_board_?id|posting_?id|locale|source|referrer)$/i
            .test(e.name)
        ) return false;
        if (e.type === "hidden" || e.readOnly || !e.getClientRects().length) {
          return ["checkbox", "radio"].includes(e.type) ? e.checked : !!e.value;
        }
        return false;
      }).map((e: any) => ({ name: e.name, value: String(e.value ?? "") }))
    );
    // A field the engine filled itself with the approved answer is explained, wherever the page put it since: a form in
    // pages hides the page it just left (round 2 of the apply scenarios, 2026-10-30: every hidden-section wizard stopped
    // at its second page on the person's own answers from the first).
    const ours = (h: { name: string; value: string }) =>
      Object.hasOwn(planned, h.name) && Object.hasOwn(wire, h.name) && typeof wire[h.name] === "string" && wire[h.name] === h.value;
    const unexplained = hidden.filter((h: any) =>
      !(pageFields && Object.hasOwn(pageFields, h.name) && pageFields[h.name] === h.value) && !echoed(h.value) && !ours(h)
    );
    if (unexplained.length) throw fail("UNCONFIRMED_HIDDEN_FIELD: " + unexplained.map((h: any) => h.name).join(", "));
  }
  const formAction = () =>
    page.evaluate(() => {
      const doc = (globalThis as any).document,
        control = Array.from(doc.querySelectorAll("button,input[type=submit]")).find((e: any) =>
          !e.disabled && e.getClientRects().length && /submit/i.test(e.innerText || e.value || "")
        ) as any;
      const form = control?.form || control?.closest("form");
      return form ? { url: form.action, method: form.method } : null;
    });
  // WO-096: fills the page's one visible code box (by its label, name, placeholder or one-time-code autocomplete).
  // Exactly one box, or nothing is typed: split one-character boxes and two code boxes are the person's. Returns whether
  // it filled the box. It never presses anything (D-029 rule 5).
  async function typeCode(code: EmailCode): Promise<boolean> {
    const marked = await page.evaluate(() => {
      const d = (globalThis as any).document;
      const named = /(verification|security|email|one[- _]?time|confirmation)[\s_-]*code|\botp\b|passcode|^code$/i;
      const words = (e: any) => {
        const label = e.id ? d.querySelector(`label[for="${String(e.id).replace(/"/g, "")}"]`) : null;
        return [label?.innerText, e.getAttribute("aria-label"), e.name, e.id, e.placeholder].filter(Boolean).join(" ").trim();
      };
      const boxes = Array.from(d.querySelectorAll("input")).filter((e: any) =>
        !e.disabled && !e.readOnly && e.getClientRects().length && ["text", "tel", "number", "search"].includes(e.type) &&
        (e.autocomplete === "one-time-code" || named.test(words(e)) || named.test(String(e.name || "")))
      ) as any[];
      if (boxes.length !== 1 || (boxes[0].maxLength > 0 && boxes[0].maxLength < 4)) return false;
      boxes[0].setAttribute("data-trainee-code-box", "1");
      return true;
    });
    if (!marked) return false;
    // D-029 rule 5: filled only, nothing pressed. The person presses Submit.
    await page.fill("[data-trainee-code-box]", code.reveal());
    return true;
  }
  // A verification on the page is the person's: they complete it in the browser window, press Enter, and the run
  // re-checks the same page (no reload, which would lose what they did). Three tries, then it stops as needs_user.
  async function handOff(): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      console.log("A verification is showing in the browser window. Complete it yourself, then press Enter here.");
      await answer();
      if (!(await page.evaluate(helper.detectChallenge))) return true;
    }
    return false;
  }
  // Every approved answer and the approved resume in a body the page sent; throws the name of one missing or changed.
  const carriesApproved = (got: Awaited<ReturnType<typeof bodyContents>>) => verifyCarries(got, wire, current?.bindings || {});
  const helper = require("./career/portal-browser-helper.cjs");
  if (o.headed) Deno.env.set("UPMORE_BROWSER_HEADED", "1");
  try {
    session = await helper.createSession();
    page = await session.page();
    await page.route("**/*", async (route: any) => {
      const req = route.request(),
        url = new URL(req.url()),
        main = req.isNavigationRequest() && req.frame() === page.mainFrame();
      const same = url.origin === u.origin;
      const sameTenant = target.local || url.pathname.split("/").filter(Boolean)[0] === target.tenant;
      if (main && (!same || !sameTenant)) {
        denied = true;
        await route.abort("blockedbyclient");
        return;
      }
      if (main && !allowSubmit && !codeWindow) {
        try {
          if (posting(url).key !== target.key) throw Error();
        } catch {
          denied = true;
          await route.abort("blockedbyclient");
          return;
        }
      }
      // A real provider's requests go out from the browser itself (its own cookies and connection, as for the person).
      if (!main && CAPTCHA_PROVIDER.test(url.href)) {
        await route.continue();
        return;
      }
      // Local fixtures only: a loopback stand-in provider, answered through the route because Chromium refuses a
      // loopback request from a page the route served.
      if (!main && target.local && /^127\./.test(url.hostname) && url.pathname.startsWith("/captcha-provider/")) {
        await route.fulfill({ response: await route.fetch() });
        return;
      }
      if (populated && !same) {
        await route.abort("blockedbyclient");
        return;
      }
      // Ashby builds its application form from GraphQL queries posted to its own origin: a query reads, a mutation would
      // write. Queries only, only on the employer's own origin; the operation names are kept in the evidence.
      const readQuery = same && !main && req.method() === "POST" && readOnly(req);
      if (readQuery) {
        try {
          const ops = [JSON.parse(req.postData() || "")].flat();
          evidence.reads = [
            ...new Set([...(evidence.reads || []), ...ops.map((x: any) => x.operationName || "anonymous")]),
          ]
            .slice(0, 50);
        } catch { /* readOnly already parsed it */ }
      }
      // The resume upload while filling: Lever parses the file as soon as it is chosen and sets a hidden storage id from
      // the employer's answer (tests/fixtures/forms-ci: resumeStorageId, /js/parseResume.js). Only for an application the
      // person approved before this run (--approved), only to the employer's own origin, only a multipart body carrying
      // the approved resume and nothing else, at most twice. Without a prior approval it stays stopped.
      // A write while the code window is open: the person's code going to the employer. One per try, the employer's
      // own site only. If it re-sends any part of the application (Greenhouse asks for the code on the form itself and
      // the form goes again), it must carry every approved answer and the approved resume unchanged. Keys only are kept.
      let codeReq = false;
      if (
        codeWindow && codeWrites < codeAllowance && same && sameTenant && !["GET", "HEAD"].includes(req.method()) &&
        !readQuery
      ) {
        const type = req.headers()["content-type"] || "", body = req.postDataBuffer() || new Uint8Array();
        try {
          let form: FormData | null = null;
          if (type.startsWith("multipart/form-data") || type.startsWith("application/x-www-form-urlencoded")) {
            form = await new Response(new Uint8Array(body), { headers: { "Content-Type": type } }).formData();
          }
          const keys = bodyShape(type, body, form), got = await bodyContents(type, body, form);
          const approvedValues = Object.values(wire).filter((v) => typeof v === "string" && v.length >= 4);
          const resends = keys.some((k) => Object.hasOwn(wire, k.split(".").pop()!.replace(/\[\]$/, ""))) ||
            !!form && [...form.values()].some((v) => typeof v !== "string") || approvedValues.some((v) =>
              got.strings.includes(v as string)
            );
          if (resends) carriesApproved(got);
          evidence.code_requests = [
            ...(evidence.code_requests || []),
            { method: req.method(), url: url.origin + url.pathname, content_type: type.split(";")[0], keys, resends },
          ];
        } catch {
          evidence.code_rejection = "CODE_REQUEST_CHANGED_APPLICATION";
          await route.abort("blockedbyclient");
          return;
        }
        codeWrites++;
        codeReq = true;
      }
      let uploadReq = false;
      if (!allowSubmit && o.approved && same && !main && req.method() === "POST" && !readQuery && resumeUploads < 2) {
        const type = req.headers()["content-type"] || "";
        if (type.startsWith("multipart/form-data")) {
          try {
            const form = await new Response(new Uint8Array(req.postDataBuffer() || new Uint8Array()), {
              headers: { "Content-Type": type },
            }).formData();
            const parts = [...form.entries()];
            const files = parts.filter(([, v]) => typeof v !== "string") as [string, File][];
            const others = parts.filter(([, v]) => typeof v === "string" && v !== "");
            if (
              files.length === 1 && !others.length &&
              sha(new Uint8Array(await files[0][1].arrayBuffer())) === artifact.sha256
            ) {
              uploadReq = true;
              resumeUploads++;
              evidence.uploads = [
                ...(evidence.uploads || []),
                { url: url.origin + url.pathname, keys: [...new Set(form.keys())].sort() },
              ];
            }
          } catch { /* not a resume upload: stopped below */ }
        }
      }
      if (codeReq) {
        // goes out as the person's page sent it
      } else if (uploadReq) {
        // goes out as the browser sent it; the employer's answer is kept to explain the hidden field it fills
      } else if (!["GET", "HEAD"].includes(req.method()) && !readQuery && scripted && scriptEndpoint && allowSubmit) {
        // Trainee clicked the employer's own Submit; the employer's script sends the application. Exactly one request
        // goes: to this posting's own application endpoint, carrying exactly the approved answers and resume (the same
        // verifier as the person's own Submit). Any other write is stopped and recorded; a second application request
        // is stopped; one that carries a changed answer is stopped before it leaves, and nothing is sent.
        const type = req.headers()["content-type"] || "", body = req.postDataBuffer() || new Uint8Array();
        const at = url.origin + url.pathname;
        let form: FormData | null = null;
        try { form = await formOf(type, body); } catch { /* not form data: read as it is */ }
        const endpoint = isSubmitEndpoint(scriptEndpoint, { method: req.method(), url: req.url(), type, body, form });
        if (!endpoint || mutations) {
          stopped.push({ method: req.method(), url: at, why: endpoint ? "second_application_request" : "not_the_application_endpoint" });
          evidence.stopped_requests = stopped.slice(0, 20);
          // Answers on their way anywhere else, before the application went: the run stops with nothing sent.
          if (!endpoint && !mutations) {
            try {
              const got = await bodyContents(type, body, form);
              if (Object.values(wire).some((v) => typeof v === "string" && v.length >= 4 && got.strings.includes(v))) {
                evidence.transport_rejection = "SUBMIT_DESTINATION_UNEXPECTED";
              }
            } catch { /* unreadable: stopped all the same */ }
          }
          await route.abort("blockedbyclient");
          return;
        }
        try {
          evidence.request_shape = { method: req.method(), url: at, content_type: type.split(";")[0], keys: bodyShape(type, body, form) };
          carriesApproved(await bodyContents(type, body, form));
        } catch {
          evidence.transport_rejection = "APPROVED_BODY_MISMATCH";
          stopped.push({ method: req.method(), url: at, why: "approved_body_mismatch" });
          evidence.stopped_requests = stopped.slice(0, 20);
          await route.abort("blockedbyclient");
          return;
        }
        if (!(await authorizeEffect(route))) return;
        mutations++;
        destination = req.url();
        postStatus = 0;
      } else if (!["GET", "HEAD"].includes(req.method()) && !readQuery && personSubmits && allowSubmit) {
        // The person pressed Submit. The first write to the employer's own origin is the application: its shape is
        // recorded (keys, never values); it goes through only if it carries every approved answer and the approved
        // resume, and only once.
        if (mutations || !same) {
          await route.abort("blockedbyclient");
          return;
        }
        const type = req.headers()["content-type"] || "", body = req.postDataBuffer() || new Uint8Array();
        let form: FormData | null = null;
        try {
          if (type.startsWith("multipart/form-data") || type.startsWith("application/x-www-form-urlencoded")) {
            form = await new Response(new Uint8Array(body), { headers: { "Content-Type": type } }).formData();
          }
          evidence.request_shape = {
            method: req.method(),
            url: url.origin + url.pathname,
            content_type: type.split(";")[0],
            keys: bodyShape(type, body, form),
          };
          carriesApproved(await bodyContents(type, body, form));
        } catch {
          evidence.transport_rejection = "APPROVED_BODY_MISMATCH";
          await route.abort("blockedbyclient");
          return;
        }
        if (!(await authorizeEffect(route))) return;
        mutations++;
        destination = req.url();
        postStatus = 0;
      } else if (!["GET", "HEAD"].includes(req.method()) && !readQuery) {
        if (!allowSubmit || req.method() !== "POST" || req.url() !== destination || mutations) {
          await route.abort("blockedbyclient");
          return;
        }
        try {
          const body = req.postDataBuffer(), type = req.headers()["content-type"] || "";
          if (!body || !type.startsWith("multipart/form-data")) throw Error();
          const data = await new Response(new Uint8Array(body), { headers: { "Content-Type": type } }).formData(),
            seen = new Set();
          for (const [name, value] of data.entries()) {
            if (
              !Object.hasOwn(wire, name) && pageFields && Object.hasOwn(pageFields, name) && value === pageFields[name]
            ) {
              if (seen.has(name)) throw Error();
              seen.add(name);
              continue;
            }
            if (!Object.hasOwn(wire, name) && typeof value === "string" && echoed(value) && !seen.has(name)) {
              seen.add(name);
              continue;
            }
            if (!Object.hasOwn(wire, name) && CAPTCHA_TOKEN.test(name)) {
              if (typeof value !== "string" || value.length > 20000 || seen.has(name)) throw Error();
              seen.add(name);
              if (value) evidence.verification_token = { field: name, length: value.length };
              continue;
            }
            if (!Object.hasOwn(wire, name)) {
              if (
                typeof value === "string" &&
                (value === "" ||
                  /^(csrf(?:_token)?|authenticity_token|_token|utf8|job_?id|posting_?id|locale|source|referrer|commit|submit)$/i
                    .test(name))
              ) continue;
              if (typeof value !== "string" && value.size === 0 && value.name === "") continue;
              throw Error();
            }
            if (seen.has(name)) throw Error();
            seen.add(name);
            const want = wire[name];
            if (typeof want === "object") {
              if (
                typeof value === "string" || value.name !== want.filename ||
                sha(new Uint8Array(await value.arrayBuffer())) !== want.sha256
              ) throw Error();
            } else if (value !== want) throw Error();
          }
          for (const name of Object.keys(wire)) if (wire[name] !== null && !seen.has(name)) throw Error();
        } catch {
          evidence.transport_rejection = "APPROVED_BODY_MISMATCH";
          await route.abort("blockedbyclient");
          return;
        }
        if (!(await authorizeEffect(route))) return;
        mutations++;
      }
      // A request the network refuses (an unreachable image host) is that request's failure, not the run's: it fails in
      // the page as it would for the person. A failed POST after it was counted stays counted (outcome unknown).
      let response;
      try {
        response = await route.fetch({ maxRedirects: 0 });
      } catch {
        await route.abort("failed").catch(() => {});
        return;
      }
      if (!["GET", "HEAD"].includes(req.method()) && !readQuery && !codeReq && req.url() === destination) {
        postStatus = response.status();
      }
      // Mass submission (owner, 2026-10-27): the employer's site refusing for load (a 429 or a 503, with or without
      // Retry-After: pageRefusal) on the page itself, before anything was filled, stops the run as not sent; the worker
      // backs off that host for every instance and puts the same job back until the host allows (HOST_RATE_LIMITED, with
      // the seconds it asked for, or none: the default doubling).
      const refused = main && !allowSubmit ? pageRefusal(response.status(), response.headers()["retry-after"], Date.now()) : null;
      if (refused) evidence.rate_limited = refused;
      if (uploadReq) uploadEchoes.push((await response.text()).slice(0, 20000));
      if (response.status() >= 300 && response.status() < 400) {
        const targetURL = new URL(response.headers().location || "/", req.url());
        let valid = targetURL.origin === u.origin &&
          (target.local || targetURL.pathname.split("/").filter(Boolean)[0] === target.tenant);
        try {
          if (!allowSubmit && !codeWindow && posting(targetURL).key !== target.key) valid = false;
        } catch {
          valid = false;
        }
        if (!valid) {
          denied = true;
          await route.fulfill({ status: 403, body: "Off-domain redirect refused" });
          return;
        }
      }
      await route.fulfill({ response });
    });
    const opened = await send({ type: "open", url: u.href });
    if (denied || opened.blockedNavigation) throw fail("HOST_REDIRECT_REFUSED");
    if (evidence.rate_limited) {
      return write({ state: "not_submitted", reason: "HOST_RATE_LIMITED", status: evidence.rate_limited.status, retry_after_s: evidence.rate_limited.retry_after_s });
    }
    if (opened.captcha && !(o.handoff && await handOff())) return write({ state: "needs_user", reason: "captcha" });
    const history: any = {}, values: any = {}, planned: any = {};
    for (let step = 0; step < 8; step++) {
      current = await observe();
      if (current.raw.some((f: any) => f.inputType === "password")) throw fail("ACCOUNT_LOGIN_REQUIRED");
      const idFields = current.schema.filter((f: any) => IDENTITY_NUMBER.test(f.label || f.name) || IDENTITY_NUMBER.test(String(f.name || "").replace(/[_\-\[\]]+/g, " ")));
      if (idFields.length) {
        return write({
          state: "not_submitted",
          reason: "IDENTITY_NUMBER_REQUESTED",
          fields: idFields.map((f: any) => f.label),
        });
      }
      if (pageFields === null) {
        pageFields = {};
        const found = await page.evaluate(() =>
          Array.from((globalThis as any).document.querySelectorAll("input[type=hidden]")).map((e: any) => ({
            name: e.name,
            value: String(e.value ?? ""),
          }))
        );
        for (const h of found as any[]) {
          if (!h.name || !h.value || CAPTCHA_TOKEN.test(h.name)) continue;
          if (consentOnBehalf(h.name, h.value)) throw fail("UNCONFIRMED_HIDDEN_FIELD: " + h.name);
          pageFields[h.name] = h.value;
        }
      }
      // A code box on the form before anything was approved: there is no approved application yet to read mail for
      // (WO-096 reads a code only inside one), so the person types it.
      if (current.schema.some((f: any) => /verification code|one[- ]time|email.*code|passcode/i.test(f.label))) {
        return write({
          state: "needs_user",
          reason: "email_code",
          stop: "This form asks for an emailed code before the application can be shown to you. Type the code on the page yourself.",
        });
      }
      // WO-053: where the job is, as its page shows it (the extension reads it the same way); WO-055: it goes with the
      // questions too, so an answer about a job abroad is kept as that posting's.
      const location = String(await page.evaluate(fnPostingLocation).catch(() => ""));
      // WO-102: planned on the trusted facts only, and every answer judged by the contract before anything is filled.
      const p = planApplication({
        manifest,
        userId: facts.user_id,
        jobId: target.key,
        employer: target.employer,
        location,
        schema: current.schema,
        artifact,
        now: Date.now(),
      });
      if (!p.ready) {
        for (const n of p.needs) console.log("Required confirmed answer: " + JSON.stringify(n.label));
        // Each question as the form asks it (its type and the employer's own options), so it can be asked once by text and
        // answered in the form's own terms; `fields` keeps the labels for older readers. A list longer than 60 (every
        // country) goes as none: the answer is then typed and checked against the full list at the next preparation.
        const questions = p.needs.map((n: any) => {
          const f = current.schema.find((x: any) => n.field_name ? x.name === n.field_name : x.label === n.label) || {};
          const all = f.options || [];
          return { label: rowQuestionLabel(f) || n.label, type: rowQuestionType(f, target.key, questionFieldType(f)), options: all.length <= 60 ? all.map((o: any) => String(o.label)) : [] };
        });
        // The form's own words about AI help (WO-030), even when a standing consent filled that question: Trainee reads
        // them before it ever drafts a written answer for this posting.
        const ai_policy = aiPolicyStatements(current.schema.map((f: any) => f.label));
        // WO-102: why the contract turned an answer back into a question, and which facts it left out (ids and reasons,
        // never values).
        const contract = p.needs.filter((n) => n.why).map((n) => ({ label: n.label, why: n.why }));
        evidence.trust = trustRecord(manifest);
        return write({ state: "not_submitted", reason: "needs_answers", posting: target.key, company: target.employer, location, fields: p.needs.map((n: any) => n.label), questions, ...(contract.length ? { contract } : {}), ...(ai_policy.length ? { ai_policy } : {}) });
      }
      const fields = p.fields, before = await hashApplyPayload(current.schema);
      for (const f of fields) {
        populated = true;
        const b = current.bindings[f.name];
        if (b.inputType === "file" && classifyField(f.label, "file") !== "resume") {
          throw fail("UNSUPPORTED_FILE_ARTIFACT: " + f.label);
        }
        if (planned[f.name] && planned[f.name].label !== f.label) throw fail("FIELD_MEANING_CHANGED: " + f.name);
        const v = b.inputType === "file" ? artifact : b.inputType === "checkbox" ? yesish(f.value) : f.value;
        const filled = await send({
          type: "fill",
          binding: b,
          value: v,
          ...(b.inputType === "file" ? { filePath: o.resume } : {}),
        });
        if (filled.filled !== true) throw fail("FIELD_DID_NOT_PERSIST: " + f.label);
        planned[f.name] = f;
        values[f.name] = expected(f, b);
        history[f.name] = b;
        wire[f.name] = b.inputType === "file"
          ? artifact
          : b.inputType === "checkbox"
          ? (v ? (current.raw.find((x: any) => (x.name || x.id) === f.name)?.optionValue || "on") : null)
          : f.value;
      }
      current = await observe();
      if (await hashApplyPayload(current.schema) !== before) continue;
      for (const f of fields) history[f.name] = current.bindings[f.name];
      const read = await send({ type: "readback", bindings: Object.values(history) });
      evidence.readback = read.answers;
      for (const [name, value] of Object.entries(values)) {
        if (!matches(read.answers[name], value)) throw fail("READBACK_MISMATCH: " + name);
      }
      await unconfirmed(current, planned);
      const review = await send({
        type: "review",
        // A field on the page now that was not there at this observation is new; an optional field the engine leaves
        // alone on purpose (no name, id or field path) is not, or the run would loop on it until FORM_DID_NOT_SETTLE.
        knownSelectors: [
          ...Object.values(current.bindings).flatMap((b: any) =>
            b.options?.length && ["radio_group", "checkbox_group"].includes(b.inputType)
              ? b.options.map((x: any) => x.selector)
              : [b.selector]
          ),
          ...current.raw.map((f: any) => f.selector),
        ].filter(Boolean),
      });
      if (denied || review.blockedNavigation) throw fail("HOST_REDIRECT_REFUSED");
      if (review.captcha && !(o.handoff && await handOff())) return write({ state: "needs_user", reason: "captcha" });
      if (review.code) throw fail(review.code);
      if (review.advanced || review.needsFields) continue;
      if (!review.atFinalReview) throw fail("FINAL_REVIEW_NOT_OBSERVED");
      if (
        !Object.values(values).some((v: any) =>
          v && typeof v === "object" && v.filename === artifact.filename && v.sha256 === artifact.sha256
        )
      ) throw fail("RESUME_INPUT_NOT_OBSERVED");
      const action = await formAction();
      const bound = !!action && new URL(action.url).origin === u.origin && action.method.toLowerCase() === "post" &&
        (target.local || posting(new URL(action.url)).key === target.key);
      // A form that submits from the employer's script binds its one request at the route (scriptEndpoint) instead.
      scripted = !!scriptEndpoint && !bound;
      if (!bound && !personSubmits && !scripted) throw fail("SUBMIT_DESTINATION_NOT_BOUND");
      destination = bound ? action.url : "";
      evidence.fields = Object.values(planned);
      evidence.schema = current.schema; // Exact schema bytes already bound by `before`, for refusal-only question recovery.
      evidence.payload = {
        user_id: facts.user_id,
        posting: target.key,
        company,
        destination: destination || (scripted ? scriptEndpoint!.describe : "the person's own Submit, one request to " + u.origin),
        fields: evidence.fields,
        resume: artifact,
        schema_hash: before,
        facts_sha256: factsHash,
        page_fields: pageFields || {},
        verification: [
          ...new Set(((await page.evaluate(helper.captchaTech)) as string[]).map((t) => t.replace(/-widget$/, ""))),
        ],
      };
      const payloadHash = await hashApplyPayload(evidence.payload);
      // What the person approves: their answers, the resume, the form's questions, where it goes, and the names of the
      // employer's own hidden fields (their values can change with every page load; each is still checked against the
      // consent rule and kept in the evidence). The same application on a fresh load gives the same hash.
      const approvalHash = await applicationApprovalHash({
        userId: facts.user_id,
        posting: target.key,
        destination: evidence.payload.destination,
        fields: evidence.fields,
        resumeSha256: artifact.sha256,
        schemaHash: before,
        pageFieldNames: Object.keys(pageFields || {}).sort(),
        // WO-102: the facts behind the answers (fact, event, provenance) and the quarantine rules they were judged under.
        manifest,
      });
      // The source of each answer, so an approved run can be checked against the contract again (approve-first's
      // factsFromPayload carries these into the run's facts), and what the contract left out (never values).
      evidence.sources = Object.fromEntries(evidence.fields.map((f: any) => [f.factId, manifest.byFactId[f.factId]]));
      evidence.replay_sources = Object.values(manifest.byFactId);
      evidence.trust = trustRecord(manifest);
      evidence.approval_hash = approvalHash;
      evidence.payload_hash = payloadHash;
      evidence.final_url = page.url();
      await send({ type: "screenshot", path: path.join(evidenceDir, "before-review.png") });
      fs.chmodSync(path.join(evidenceDir, "before-review.png"), 0o600);
      // The answers are shown to the person reviewing them at their own terminal. Any other reader of this output (a
      // worker, a pipe, a CI log) gets the field and the fact behind it, never the answer itself.
      const reviewing = Deno.stdin.isTerminal();
      for (const f of evidence.fields) {
        console.log(JSON.stringify({ name: f.name, label: f.label, ...(reviewing ? { value: f.value } : {}), factId: f.factId }));
      }
      const shown = Object.entries(pageFields || {});
      if (shown.length) {
        console.log("Set by the employer's page, sent unchanged:");
        for (const [name, value] of shown) {
          console.log("  " + name + " = " + (value.length > 80 ? value.slice(0, 80) + "..." : value));
        }
      }
      if (evidence.payload.verification.length) {
        console.log(
          "The page runs a verification check (" + evidence.payload.verification.join(", ") +
            "). It adds its own token when you submit; the token carries none of your answers.",
        );
      }
      console.log("Resume SHA-256: " + artifact.sha256);
      console.log("Destination: " + evidence.payload.destination);
      console.log("Payload SHA-256: " + payloadHash);
      console.log("Approval hash: " + approvalHash);
      if (!o.submit) return write({ state: "not_submitted", reason: "dry_run" });
      if (!o.approved) console.log(`Submit this application to ${target.employer}? (yes/no)`);
      if (o.approved) {
        if (o.approved !== approvalHash) {
          return write({
            state: "not_submitted",
            reason: "APPROVED_APPLICATION_CHANGED",
            approved: o.approved,
            now: approvalHash,
          });
        }
        console.log("Approved earlier as " + approvalHash + "; submitting without asking again.");
      } else if (await answer() !== "yes") return write({ state: "not_submitted", reason: "user_declined" });
      if (sha(fs.readFileSync(o.facts)) !== factsHash) throw fail("FACTS_CHANGED");
      if (sha(fs.readFileSync(o.resume)) !== artifact.sha256) throw fail("RESUME_SHA_MISMATCH");
      const fresh = await observe();
      if (await hashApplyPayload(fresh.schema) !== before) throw fail("FORM_SCHEMA_CHANGED");
      await unconfirmed(fresh, planned);
      const actionNow = await formAction();
      if (
        destination &&
        (!actionNow || actionNow.url !== destination || actionNow.method.toLowerCase() !== "post")
      ) throw fail("SUBMIT_DESTINATION_CHANGED");
      for (const name of Object.keys(fresh.bindings)) {
        if (Object.hasOwn(history, name)) history[name] = fresh.bindings[name];
      }
      const verified = await send({ type: "verify_payload", bindings: Object.values(history), payload: values });
      if (!verified.matches) throw fail("PAYLOAD_CHANGED_BEFORE_CLICK");
      store.withLock(ownerLock, () => {
        const prior = store.get(id);
        if (prior && prior.state !== "not_sent") throw fail("duplicate_job");
        const log = store.list().map((key: string) => store.get(key)).filter((j: any) => j && j.state !== "not_sent")
          .map((j: any) => ({
            user_id: j.user_id,
            job_id: j.job_id,
            company: j.company,
            at: j.at,
            state: j.state === "unknown_outcome" ? "submitting" : j.state,
          }));
        const admission = admitApplication(log, {
          user_id: facts.user_id,
          job_id: target.key,
          company,
          payload_hash: payloadHash,
          approval_hash: payloadHash,
        }, Date.now());
        if (!admission.ok) throw fail(admission.reason!);
        store.put({
          id,
          user_id: facts.user_id,
          job_id: target.key,
          company,
          at: Date.now(),
          state: "submitting",
          payload_hash: payloadHash,
          approval_hash: payloadHash,
          evidence_path: evidenceDir,
        });
      });
      fenced = true;
      // D-024 (G6): the page as it stands at the click, after every check above passed, is the "before" of the proof.
      // A long answer can run past what a picture shows, so what each field held at that moment is read back too, and
      // kept as a hash per field only (it binds the picture to these answers without keeping their text again).
      // Without the picture there is no click: nothing has been sent, so the application is not sent and may be
      // tried again.
      const clickRead = await send({ type: "readback", bindings: Object.values(history) });
      const held = Object.fromEntries(Object.entries(clickRead.answers).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [name, sha(JSON.stringify(value))]));
      let beforeClick;
      try {
        beforeClick = await capture("before-click", { fields_sha256: held });
      } catch {
        throw fail("BEFORE_CLICK_PROOF_MISSING");
      }
      evidence.proof = {
        run_id: runId,
        application_id: o["application-id"] ?? null,
        approval_hash: approvalHash,
        payload_hash: payloadHash,
        before_click: beforeClick,
      };
      // WO-096: the code the employer emails is for this click; mail from before it is never read as its code.
      const clickAt = Date.now();
      // The click's place in this run's own order: after the before picture, before the after picture.
      evidence.proof.click = Object.freeze({ seq: ++proofSeq, at: clickAt });
      allowSubmit = true;
      let cap: any;
      if (personSubmits) {
        // The person presses Submit in the window; Trainee clicks nothing. The route lets exactly one write through,
        // and only with the approved answers in it. Ten minutes, then not sent.
        console.log(
          "Press Submit in the browser window now. Exactly one request goes to " + u.origin +
            ", and only if it carries your approved answers.",
        );
        for (let i = 0; i < 1200 && mutations === 0 && !evidence.transport_rejection && !denied; i++) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (evidence.transport_rejection) throw fail(evidence.transport_rejection);
        if (mutations === 0) throw fail("PERSON_DID_NOT_SUBMIT");
        await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await page.screenshot({ path: path.join(evidenceDir, "after-submit.png"), fullPage: true }).catch(() => {});
        cap = {
          clicked: true,
          captcha: await page.evaluate(helper.detectChallenge),
          finalUrl: page.url(),
          text: await page.evaluate(() =>
            String((globalThis as any).document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 6000)
          ),
        };
      } else {
        cap = await send({
          type: "submit_and_capture",
          screenshotPath: path.join(evidenceDir, "after-submit.png"),
        });
        // A script-submitted form: the employer's script sends after the click, on its own time. Wait for the one
        // request (or its refusal) and the employer's answer, then read the page as it now shows.
        if (scripted && cap.clicked && !cap.captcha && !cap.blockedNavigation) {
          for (let i = 0; i < 40 && (mutations === 0 || postStatus === 0) && !evidence.transport_rejection && !denied; i++) {
            await new Promise((r) => setTimeout(r, 500));
          }
          await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(1500);
          await page.screenshot({ path: path.join(evidenceDir, "after-submit.png"), fullPage: true }).catch(() => {});
          cap = {
            clicked: true,
            captcha: await page.evaluate(helper.detectChallenge),
            finalUrl: page.url(),
            text: await page.evaluate(() =>
              String((globalThis as any).document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 6000)
            ),
          };
        }
      }
      // An invisible check can turn into a challenge at the click. The send waits for the person: they complete it in
      // the window, the page sends the approved form itself, and the one-POST and body checks above still hold. Nothing
      // is clicked again by Trainee.
      if (cap.clicked && cap.captcha && mutations === 0 && o.handoff && !denied && !cap.blockedNavigation) {
        evidence.handoff_at_submit = true;
        if (await handOff()) {
          for (let i = 0; i < 60 && mutations === 0; i++) await new Promise((r) => setTimeout(r, 500));
          await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(2500);
          await page.screenshot({ path: path.join(evidenceDir, "after-submit.png"), fullPage: true }).catch(() => {});
          cap = {
            clicked: true,
            captcha: await page.evaluate(helper.detectChallenge),
            finalUrl: page.url(),
            text: await page.evaluate(() =>
              String((globalThis as any).document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 6000)
            ),
          };
        }
      }
      allowSubmit = false;
      evidence.post = { mutations, status: postStatus, destination, ...(scripted ? { bound_by: "script_submit_route", family: scriptFamily } : {}) };
      if (evidence.transport_rejection) throw fail(evidence.transport_rejection);
      if (denied || cap.blockedNavigation) throw fail("HOST_REDIRECT_REFUSED");
      // A challenge at the click that nobody completed: nothing left the browser, and the reason says what is needed.
      if (cap.captcha && mutations === 0) throw fail("CAPTCHA_AT_SUBMIT");
      if (!cap.clicked) throw fail("SUBMIT_EFFECT_UNCERTAIN");
      if (mutations !== 1 || !acknowledged(postStatus)) throw fail("SUBMIT_ACKNOWLEDGEMENT_UNCERTAIN");
      const outcome = async (cap: any) => {
        const after = await observe(),
          text = String(cap.text || "").slice(0, 4000),
          formPresent = await page.evaluate(
            (names: string[]) =>
              Array.from((globalThis as any).document.querySelectorAll("form")).some((form: any) =>
                Array.from(form.elements).some((e: any) => names.includes(e.name) || e.type === "file")
              ),
            Object.keys(planned),
          );
        return {
          url_before: u.href,
          url_after: cap.finalUrl || page.url(),
          form_present_after: formPresent,
          required_empty_after: after.raw.filter((f: any) => f.required && !f.valid).length,
          validation_errors: after.observation.errors || [],
          captcha: !!cap.captcha,
          email_code_prompt: /verification code|email.*code|one[- ]time code/i.test(text) ||
            after.raw.some((f: any) =>
              /(verification|security|email|one[- _]time).*code|\botp\b|passcode|^code$/i.test(f.label + " " + f.name)
            ),
          page_text: text,
        };
      };
      let obs = await outcome(cap);
      // WO-096: the employer emailed a code after the approved submit. With --email-code, Trainee reads it from the
      // person's own Gmail (read-only: the posting's application system's own senders, mail after the click) and fills
      // the page's one code box. It presses nothing (D-029 rule 5): headless, the run stops at needs_user; with
      // --handoff the person presses Submit and the code window below lets that one write go under its rules. The code
      // stays in memory: it is never printed and never in the evidence.
      let stop: string | null = null, codeFilled = false;
      if (obs.email_code_prompt && !obs.captcha && !denied && !readCode && !o.handoff) {
        stop = codeStop("no_google_connection", codeAts ?? "");
      }
      if (obs.email_code_prompt && !obs.captcha && !denied && readCode) {
        const got: CodeRead = codeAts ? await readCode({ ats: codeAts, sinceMs: clickAt }) : { status: "not_yet" };
        evidence.code_auto = { ats: codeAts, status: got.status };
        if (got.status === "found" && got.code) {
          // D-029 rule 5: the code is filled and nothing is pressed. The person presses Submit (with --handoff the run
          // watches for it below; headless, the run stops here at needs_user).
          typedCode = got.code;
          const typed = await typeCode(got.code);
          evidence.code_auto.typed = typed;
          codeFilled = typed;
          // Every input is masked in the picture: the code box holds the code.
          await page.screenshot({
            path: path.join(evidenceDir, "after-code.png"),
            fullPage: true,
            mask: [page.locator("input, textarea, [contenteditable]")],
          }).catch(() => {});
          stop = typed
            ? `Filled the code ${ATS_NAMES[codeAts!]} emailed you. Press Submit to finish.`
            : "The page's code box could not be found. Type the code the employer emailed you on the page yourself.";
        } else {
          stop = got.stop || codeStop("not_yet", codeAts ?? "");
        }
      }
      // The employer emailed a code. With --handoff the person types it into the page and presses its button; the
      // window lets one write per try reach the employer's own site, then the page is read again. Three tries.
      if (obs.email_code_prompt && !obs.captcha && o.handoff && !denied) {
        evidence.code_handoff = { tries: 0, requests: 0 };
        const asked = obs;
        for (let i = 0; i < 3 && obs.email_code_prompt && !evidence.code_rejection && !denied; i++) {
          codeAllowance = codeWrites + 1;
          codeWindow = true;
          console.log(
            codeFilled && i === 0
              ? `${stop} Press the page's Submit in the browser window yourself, then press Enter here.`
              : "The employer emailed you a verification code. Type it into the browser window and press the page's own " +
                "button yourself; Trainee never sees or keeps the code. Then press Enter here.",
          );
          await answer();
          for (let w = 0; w < 40 && codeWrites < codeAllowance && !evidence.code_rejection; w++) {
            await new Promise((r) => setTimeout(r, 500));
          }
          await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(2500);
          codeWindow = false;
          codeAllowance = codeWrites;
          // Every input is masked in the picture: a code typed and not accepted would otherwise be in it.
          await page.screenshot({
            path: path.join(evidenceDir, "after-code.png"),
            fullPage: true,
            mask: [page.locator("input, textarea, [contenteditable]")],
          }).catch(() => {});
          obs = await outcome({
            captcha: await page.evaluate(helper.detectChallenge),
            finalUrl: page.url(),
            text: await page.evaluate(() =>
              String((globalThis as any).document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 6000)
            ),
          });
          evidence.code_handoff = { tries: i + 1, requests: codeWrites };
        }
        // A refused code request never reached the employer: the page that asked for the code is still the outcome
        // (the window may show a load error for the stopped request, which says nothing about the application).
        if (evidence.code_rejection) {
          evidence.code_handoff.refused = evidence.code_rejection;
          obs = asked;
        }
        if (denied) throw fail("HOST_REDIRECT_REFUSED");
      }
      evidence.observation = obs;
      // D-024: the "after" of the proof, the page as it shows once the outcome above was read: a picture of what the
      // page showed, not proof that the employer accepted anything. Its failure is kept, never covered by an older file.
      try {
        evidence.proof.after_submit = await capture("after-submit", { final_url: page.url() });
      } catch (e: any) {
        evidence.proof.after_submit = null;
        evidence.proof.after_submit_error = String(e?.code || e?.message || e).slice(0, 200);
      }
      evidence.proof.final_url = page.url();
      Object.freeze(evidence.proof);
      // The one POST went out and the employer acknowledged it: never "not submitted" from here (outcomeAfterSend).
      const classified = outcomeAfterSend(obs);
      // Without both pictures the product never says the application went through as confirmed.
      const judged = classified.state === "confirmed" && !evidence.proof.after_submit
        ? { ...classified, state: "submitted_unconfirmed", reason: "AFTER_SUBMIT_PROOF_MISSING" }
        : classified;
      // What the person does about a code still asked for, by name (WO-096); never the code.
      const answered = judged.state === "needs_user" && judged.reason === "email_code" && stop ? { ...judged, stop } : judged;
      const result = { ...answered, proof: evidence.proof };
      const recorded = write(result);
      store.withLock(id, () => {
        const j = store.get(id);
        store.put({ ...j, state: result.state, result });
      });
      return recorded;
    }
    throw fail("FORM_DID_NOT_SETTLE");
  } catch (e: any) {
    // Fenced and nothing left the browser (the one POST was refused or never made): not sent, and the posting may be
    // tried again. Fenced and the POST went out: unknown until the employer's record says otherwise; never resent.
    const sent = fenced && mutations > 0;
    const notSentReason = evidence.transport_rejection || (denied ? "HOST_REDIRECT_REFUSED" : e.code || "DRIVER_ERROR");
    const result = {
      state: sent ? "unknown_outcome" : "not_submitted",
      reason: sent ? "READBACK_REQUIRED" : notSentReason,
      ...(evidence.proof ? { proof: evidence.proof } : {}),
    };
    if (fenced) {
      store.withLock(id, () => {
        const j = store.get(id);
        store.put({ ...j, state: sent ? "unknown_outcome" : "not_sent", reason: result.reason });
      });
    }
    return write(result);
  } finally {
    if (session) await session.close().catch(() => {});
  }
}
if (import.meta.main) {
  try {
    console.log("RESULT " + JSON.stringify(await runApply(Deno.args)));
  } catch (e: any) {
    console.log("RESULT " + JSON.stringify({ state: "not_submitted", reason: e.code || "INVALID_APPLY_INPUT" }));
    Deno.exitCode = 1;
  }
}
