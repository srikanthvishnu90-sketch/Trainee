// The stub worlds of the end-to-end eval (release 9, workstream D). Each stands where a real employer, inbox or reader
// would be, keeps what reached it, and answers as the real one does; nothing here reaches a real employer, inbox or person.
//   StubAts     a real HTTP server on 127.0.0.1 that answers for every *.greenhouse.io host the product calls: the job's
//               page and its form schema (GET), and the application form post (POST, multipart), which it RECORDS (every
//               field, every file's name and SHA-256) and answers with a confirmation id, as Greenhouse does.
//   FakeGmail   the sending rail's own fake Gmail (tests/flow/send-rail-fixture.ts, reused, never copied): it keeps each
//               message sent (To, Subject, every header, the decoded body).
//   readPdf     the file fetch for a returned document: does it open (header, a page tree, a trailer), how many pages,
//               and the text it carries (uncompressed or FlateDecode content streams, Tj/TJ strings).
//   fileHtml    the file fetch for a File page: the product's own renderer (file_kinds.ts bodyHtml) over the stored record.
// deno-lint-ignore-file no-explicit-any
import { bodyHtml, type FileRecord } from "../../../supabase/functions/_shared/file_kinds.ts";
export { FakeGmail, type SentMail } from "../../../tests/flow/send-rail-fixture.ts";

export interface AtsPost { host: string; board: string; job: string; path: string; fields: Record<string, string>; files: { name: string; filename: string; sha256: string; bytes: number }[]; confirmation_id: string; at: number }
export interface AtsJob { board: string; job: string; title: string; company: string }

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (b: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", b as BufferSource));

// The form every stub posting asks (Greenhouse's job board API shape, ?questions=true): the identity fields, the resume, and
// one screening question whose answer must come from a fact the person confirmed (never a guess).
export const ATS_QUESTIONS = [
  { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text", values: [] }] },
  { label: "Last Name", required: true, fields: [{ name: "last_name", type: "input_text", values: [] }] },
  { label: "Email", required: true, fields: [{ name: "email", type: "input_text", values: [] }] },
  { label: "Phone", required: false, fields: [{ name: "phone", type: "input_text", values: [] }] },
  { label: "Resume/CV", required: true, fields: [{ name: "resume", type: "input_file", values: [] }] },
  { label: "Are you legally authorized to work in the United States?", required: true, fields: [{ name: "question_9001", type: "multi_value_single_select", values: [{ label: "Yes", value: 1 }, { label: "No", value: 0 }] }] },
];

export class StubAts {
  posts: AtsPost[] = [];
  gets: { host: string; path: string }[] = [];
  private server: Deno.HttpServer | null = null;
  private seq = 0;
  port = 0;
  constructor(private jobs: AtsJob[]) {}
  async start() {
    const ready = Promise.withResolvers<number>();
    this.server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: ({ port }) => ready.resolve(port) }, (req) => this.handle(req));
    this.port = await ready.promise;
    return this;
  }
  async stop() { await this.server?.shutdown(); this.server = null; }
  private find(path: string): AtsJob | null {
    const m = /^\/(?:v1\/boards\/)?([^/]+)\/jobs\/(\d+)/.exec(path);
    return m ? this.jobs.find((j) => j.board === m[1] && j.job === m[2]) ?? null : null;
  }
  private async handle(req: Request): Promise<Response> {
    const u = new URL(req.url), host = req.headers.get("x-stub-host") ?? "", job = this.find(u.pathname);
    if (req.method === "GET") {
      this.gets.push({ host, path: u.pathname });
      if (!job) return new Response("not found", { status: 404 });
      if (host.startsWith("boards-api.")) return Response.json({ id: Number(job.job), title: job.title, company_name: job.company, absolute_url: `https://boards.greenhouse.io/${job.board}/jobs/${job.job}`, questions: ATS_QUESTIONS });
      // The page the person's browser would open: the posting and its form.
      const inputs = ATS_QUESTIONS.flatMap((q) => q.fields.map((f) => f.type === "input_file" ? `<label>${q.label}<input type="file" name="${f.name}"></label>`
        : f.values.length ? `<label>${q.label}<select name="${f.name}">${f.values.map((v) => `<option value="${v.value}">${v.label}</option>`).join("")}</select></label>`
        : `<label>${q.label}<input type="text" name="${f.name}"${q.required ? " required" : ""}></label>`)).join("\n");
      return new Response(`<!doctype html><title>${job.title} at ${job.company}</title><h1>${job.title}</h1><form method="post" enctype="multipart/form-data" action="/${job.board}/jobs/${job.job}">${inputs}<button type="submit">Submit application</button></form>`, { headers: { "content-type": "text/html" } });
    }
    if (req.method === "POST") {
      if (!job) return new Response("not found", { status: 404 });
      let form: FormData;
      try { form = await req.formData(); } catch { return Response.json({ error: "a form post is multipart/form-data" }, { status: 400 }); }
      const fields: Record<string, string> = {}, files: AtsPost["files"] = [];
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") fields[k] = v;
        else { const b = new Uint8Array(await v.arrayBuffer()); files.push({ name: k, filename: v.name, sha256: await sha256Hex(b), bytes: b.length }); }
      }
      const missing = ATS_QUESTIONS.filter((q) => q.required).flatMap((q) => q.fields).filter((f) => f.type === "input_file" ? !files.some((x) => x.name === f.name) : !String(fields[f.name] ?? "").trim());
      if (missing.length) return Response.json({ error: `required: ${missing.map((f) => f.name).join(", ")}` }, { status: 422 });
      const confirmation_id = `GH-${job.board}-${job.job}-${++this.seq}`;
      this.posts.push({ host, board: job.board, job: job.job, path: u.pathname, fields, files, confirmation_id, at: Date.now() });
      return host.startsWith("boards-api.") ? Response.json({ success: true, confirmation_id })
        : new Response(`<!doctype html><h1>Thank you for applying to ${job.company}.</h1><p>Confirmation: ${confirmation_id}</p>`, { headers: { "content-type": "text/html" } });
    }
    return new Response("method not allowed", { status: 405 });
  }
  // A fetch that forwards a *.greenhouse.io request to this server (a real HTTP hop, so the post is a real form post).
  forward = async (req: Request, realFetch: typeof fetch): Promise<Response> => {
    const u = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("x-stub-host", u.hostname);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    return await realFetch(`http://127.0.0.1:${this.port}${u.pathname}${u.search}`, { method: req.method, headers, body });
  };
}

// ------------------------------------------------------------------------------------------------ the engine stand-in
// The eval's engine for the cloud worker (runCloudJob's RunEngine): exactly the Submit step of scripts/apply.ts, over HTTP
// instead of a browser (the eval runs headless of any browser, so it runs anywhere Postgres does; the real engine's form
// driving is covered by tests/career-cloud-worker.test.cjs). It refuses an application that is no longer the approved one (the approved hash
// over factsFromPayload, as the real engine checks), opens the posting (closed: nothing sent), asks the queue to authorize the
// one effect, then posts exactly the approved fields and the approved resume bytes as multipart/form-data, and reports the
// employer's confirmation. It decides nothing the real engine would not; everything else is the product's own worker.
const arg = (a: string[], k: string) => a[a.indexOf(k) + 1];
export function stubEngine(job: any, hashOf: (x: unknown) => Promise<string>, factsFromPayload: (p: any) => any) {
  return async (args: string[], _env?: Record<string, string>, controls?: { beforeEffect?: () => Promise<void> }) => {
    const facts = JSON.parse(await Deno.readTextFile(arg(args, "--facts")));
    if (!args.includes("--submit") || arg(args, "--approved") !== await hashOf(facts.saved) || arg(args, "--approved") !== await hashOf(factsFromPayload(job.payload).saved)) {
      return { result: { state: "not_submitted", reason: "APPROVED_APPLICATION_CHANGED" }, evidence: null };
    }
    const resume = await Deno.readFile(arg(args, "--resume"));
    const u = new URL(job.payload.destination || job.url), m = /\/([^/]+)\/jobs\/(\d+)/.exec(u.pathname);
    if (!m) return { result: { state: "not_submitted", reason: "SUBMIT_DESTINATION_NOT_BOUND" }, evidence: null };
    const open = await fetch(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}?questions=true`);
    if (open.status === 404) return { result: { state: "not_submitted", reason: "POSTING_CLOSED" }, evidence: null };
    await open.body?.cancel();
    try { await controls?.beforeEffect?.(); } catch { return { result: { state: "not_submitted", reason: "CARD_CLOUD_AUTHORIZATION_REFUSED" }, evidence: null }; }
    const form = new FormData();
    for (const f of (job.payload.fields ?? []) as any[]) if (!/file/i.test(String(f?.type ?? "")) && f?.name !== "resume") form.append(String(f.name), String(f.value ?? ""));
    form.append("resume", new Blob([resume], { type: "application/pdf" }), arg(args, "--resume").split("/").pop() || "resume.pdf");
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`, { method: "POST", body: form });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { result: { state: "failed", reason: String(body?.error ?? `HTTP ${r.status}`).slice(0, 80) }, evidence: { post: { status: r.status, mutations: 1 } } };
    return { result: { state: body.confirmation_id ? "confirmed" : "submitted_unconfirmed", reason: "acknowledged", confirmation_id: body.confirmation_id ?? null, proof: { status: r.status, confirmation_id: body.confirmation_id ?? null } },
      evidence: { post: { status: r.status, mutations: 1, destination: r.url }, observation: { page_text: `Confirmation: ${body.confirmation_id ?? ""}` } } };
  };
}

// ------------------------------------------------------------------------------------------------ the document fetch
export interface PdfInfo { opens: boolean; why: string | null; pages: number; text: string }
const latin1 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s; };
async function inflate(b: Uint8Array): Promise<Uint8Array | null> {
  try {
    const ds = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  } catch { return null; }
}
// The strings a content stream draws: (..) Tj, [(..) n (..)] TJ, ' and ". Escapes decoded; kerning gaps of more than
// 200 thousandths of an em read as a space.
export function drawnText(ops: string): string {
  const str = (s: string) => s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[e] ?? String.fromCharCode(parseInt(e, 8)));
  const out: string[] = [];
  const re = /\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|(T\*|Td|TD|ET)\b/g;
  for (let m; (m = re.exec(ops));) {
    if (m[1] !== undefined) {
      let line = "";
      for (const p of m[1].matchAll(/\(((?:\\.|[^\\)])*)\)|(-?\d+(?:\.\d+)?)/g)) line += p[1] !== undefined ? str(p[1]) : Number(p[2]) < -200 ? " " : "";
      out.push(line);
    } else if (m[2] !== undefined) out.push(str(m[2]));
    else out.push("\n");
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
}
export async function readPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const s = latin1(bytes);
  if (!s.startsWith("%PDF-")) return { opens: false, why: "no %PDF- header", pages: 0, text: "" };
  if (!/%%EOF\s*$/.test(s.slice(-1024))) return { opens: false, why: "no %%EOF trailer", pages: 0, text: "" };
  if (!/\/Root\s+\d+\s+\d+\s+R/.test(s)) return { opens: false, why: "no document catalog (/Root)", pages: 0, text: "" };
  const pages = [...s.matchAll(/\/Type\s*\/Page(?![a-zA-Z])/g)].length;
  if (!pages) return { opens: false, why: "no page in the page tree", pages: 0, text: "" };
  const parts: string[] = [];
  const re = /<<((?:(?!>>\s*stream)[\s\S]){0,2000})>>\s*stream\r?\n/g;
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length, end = s.indexOf("endstream", start);
    if (end < 0) break;
    // The stream's own /Length when it is a plain number (an indirect length falls back to the bytes before endstream).
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(m[1]);
    let raw = bytes.subarray(start, len && start + Number(len[1]) <= end ? start + Number(len[1]) : end);
    while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d) && !len) raw = raw.subarray(0, raw.length - 1);
    const data = /\/FlateDecode/.test(m[1]) ? await inflate(raw) : raw;
    if (data) parts.push(latin1(data));
  }
  return { opens: true, why: null, pages, text: parts.map(drawnText).filter(Boolean).join("\n") };
}

// A File page as its reader opens it: the product's own renderer over the stored record (trainee-file serves this body).
export function fileHtml(rec: FileRecord): string { return bodyHtml(rec, "e2e-token"); }
export const htmlText = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
