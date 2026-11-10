// The one check for a request that carries an approved application out of the browser (scripts/apply.ts), whichever
// hand sends it: the person's own Submit (--person-submits), the agent's click on the employer's own Submit for a form
// that posts from its script (script submit binding, below), or a code request that re-sends the form (WO-096).
//   - bodyShape: the request's keys, never its values (multipart part names, JSON key paths "a.b", "list[]");
//   - bodyContents: every string it carries and the SHA-256 of every file (multipart files, or base64 JSON strings);
//   - carriesApproved: every approved answer and the approved resume are in it, and a key named for an approved field
//     carries that field's approved value and nothing else (a changed answer under its own name is stopped even when
//     the approved value also appears elsewhere in the body).
// And where it may go: scriptSubmitEndpoint names the employer's own application endpoint for the posting (Greenhouse's
// application POST for that board and job, Ashby's GraphQL application mutation, Lever's apply POST); isSubmitEndpoint
// says whether a request is that one request.
import crypto from "node:crypto";

const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

// uploads: the SHA-256 of every non-empty multipart file part, the files that actually leave as files (x-audit).
export type Got = { strings: string[]; files: string[]; keyed: [string, string][]; uploads?: string[] };
export type Wire = Record<string, string | null | { filename: string; sha256: string }>;
export type Binding = { inputType?: string; options?: { value: string; label: string }[] };

// A multipart or urlencoded body as form data; null for anything else (JSON is read as text).
export async function formOf(type: string, body: Uint8Array): Promise<FormData | null> {
  if (!type.startsWith("multipart/form-data") && !type.startsWith("application/x-www-form-urlencoded")) return null;
  return await new Response(new Uint8Array(body), { headers: { "Content-Type": type } }).formData();
}

// A JSON value as [key path, leaf] pairs. GraphQL's multipart request (Ashby's file upload) carries its JSON in an
// "operations" part, which is walked as JSON too.
function leaves(v: unknown, at = "", out: [string, unknown][] = []) {
  if (Array.isArray(v)) v.forEach((x) => leaves(x, at + "[]", out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, at ? at + "." + k : k, out);
  else if (at) out.push([at, v]);
  return out;
}
function jsonOf(type: string, body: Uint8Array): unknown {
  if (!/json/.test(type)) return undefined;
  return JSON.parse(new TextDecoder().decode(body));
}

export function bodyShape(type: string, body: Uint8Array, form: FormData | null): string[] {
  if (form) return [...new Set([...form.keys()])].sort();
  try {
    const j = jsonOf(type, body);
    if (j === undefined) return [];
    return [...new Set(leaves(j).map(([k]) => k))].sort();
  } catch {
    return [];
  }
}

export async function bodyContents(type: string, body: Uint8Array, form: FormData | null): Promise<Got> {
  const strings: string[] = [], files: string[] = [], keyed: [string, string][] = [], uploads: string[] = [];
  const text = (key: string, v: unknown) => {
    if (v === null || v === undefined) return;
    const s = String(v);
    strings.push(s);
    keyed.push([key, s]);
    const b64 = s.replace(/^data:[^,]*;base64,/, "");
    if (b64.length > 16 && /^[A-Za-z0-9+/=\s]+$/.test(b64)) {
      try {
        files.push(sha(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0))));
      } catch { /* not base64 */ }
    }
  };
  if (form) {
    for (const [k, v] of form.entries()) {
      if (typeof v !== "string") {
        const b = new Uint8Array(await v.arrayBuffer());
        files.push(sha(b));
        if (b.length) uploads.push(sha(b)); // an empty part is a file input left empty, not a file sent
      }
      else if (k === "operations") {
        try { for (const [p, x] of leaves(JSON.parse(v))) text(p, x); } catch { strings.push(v); keyed.push([k, v]); }
      } else { strings.push(v); keyed.push([k, v]); }
    }
    return { strings, files, keyed, uploads };
  }
  const j = jsonOf(type, body);
  if (j !== undefined) for (const [p, x] of leaves(j)) text(p, x);
  return { strings, files, keyed, uploads };
}

// The field name a key path ends in: "fields.email" -> "email", "answers[].question_1" -> "question_1".
const lastKey = (k: string) => k.split(".").pop()!.replace(/(\[\])+$/, "");

// Throws Error(<field name>) for the first approved answer the body does not carry as approved, and
// Error("unapproved_file") when a file goes out that the person did not approve (x-audit, 2026-11-10: a second upload,
// such as a cover letter attached by the employer's script, used to go out beside the approved resume).
export function carriesApproved(got: Got, wire: Wire, bindings: Record<string, Binding> = {}) {
  const approvedFiles = new Set(Object.values(wire).flatMap((w) => (w && typeof w === "object" ? [w.sha256] : [])));
  for (const u of got.uploads ?? []) if (!approvedFiles.has(u)) throw Error("unapproved_file");
  const accepted = (name: string, want: string) => {
    const b = bindings[name], opt = b?.options?.find((x) => x.value === want);
    return (v: string) => v === want || (!!opt && v === String(opt.label)) || (b?.inputType === "checkbox" && v === "true");
  };
  for (const [name, want] of Object.entries(wire)) {
    if (want === null) continue;
    if (typeof want === "object") {
      if (!got.files.includes(want.sha256)) throw Error("resume");
      continue;
    }
    const ok = accepted(name, String(want));
    // A select may carry its label rather than its value; a checked box may carry true in JSON.
    if (!got.strings.some(ok)) throw Error(name);
    // Under its own name, only the approved value.
    for (const [k, v] of got.keyed) if (lastKey(k) === name && !ok(v)) throw Error(name);
  }
}

// ---------- script submit binding ----------
export const SCRIPT_FAMILIES = ["greenhouse", "ashby", "lever"] as const;
export type ScriptFamily = typeof SCRIPT_FAMILIES[number];
export const isScriptFamily = (f: unknown): f is ScriptFamily => (SCRIPT_FAMILIES as readonly unknown[]).includes(f);
export type Endpoint = { family: ScriptFamily; origin: string; path: string; postingId: string | null; describe: string };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Ashby's application mutation (GraphQL, posted to the board's own origin).
const ASHBY_SUBMIT = /^ApiSubmit\w*Application\w*$/;

// The employer's own endpoint for this posting. local: a loopback fixture standing in for that family (its posting path
// is the fixture's own; the board and job are the fixture's).
export function scriptSubmitEndpoint(family: ScriptFamily, posting: URL, local: boolean): Endpoint {
  const segs = posting.pathname.split("/").filter(Boolean);
  const own = "/" + segs.join("/");
  let path: string, postingId: string | null = null;
  if (family === "greenhouse") {
    // job-boards.greenhouse.io/<board>/jobs/<id>: the application posts back to the job's own route.
    const id = posting.pathname.match(/\/jobs\/(\d+)/)?.[1] || null;
    if (!local && (!segs[0] || !id)) throw Error("POSTING_ID_REQUIRED");
    path = local ? own : `/${segs[0]}/jobs/${id}`;
    postingId = id;
  } else if (family === "lever") {
    // jobs.lever.co/<tenant>/<id>/apply
    if (!local && (!segs[0] || !UUID.test(segs[1] || ""))) throw Error("POSTING_ID_REQUIRED");
    path = local ? own : `/${segs[0]}/${segs[1]}/apply`;
    postingId = local ? null : segs[1];
  } else {
    // jobs.ashbyhq.com/<board>/<posting uuid>[/application]: one GraphQL endpoint; the posting is in the variables.
    postingId = posting.pathname.match(UUID)?.[0] || null;
    if (!local && !postingId) throw Error("POSTING_ID_REQUIRED");
    path = "/api/non-user-graphql";
  }
  const describe = `${posting.origin}${path} (one request${family === "ashby" ? ", the application mutation" : ""}, ` +
    `sent by the page's own Submit)`;
  return { family, origin: posting.origin, path, postingId, describe };
}

// Whether this request is the application itself, sent to the employer's own endpoint for this posting.
export function isSubmitEndpoint(ep: Endpoint, req: { method: string; url: string; type: string; body: Uint8Array; form: FormData | null }) {
  const u = new URL(req.url);
  if (req.method !== "POST" || u.origin !== ep.origin) return false;
  if (ep.family !== "ashby") return u.pathname.replace(/\/$/, "") === ep.path || u.pathname === ep.path + ".data";
  if (u.pathname !== ep.path) return false;
  let ops: any;
  try {
    const op = req.form?.get("operations");
    ops = typeof op === "string" ? JSON.parse(op) : jsonOf(req.type, req.body);
  } catch {
    return false;
  }
  const list = [ops].flat();
  if (list.length !== 1 || !ASHBY_SUBMIT.test(String(list[0]?.operationName || ""))) return false;
  return !ep.postingId || JSON.stringify(list[0]?.variables ?? {}).includes(ep.postingId);
}
