// Three employer job boards on 127.0.0.1 for the mass-apply flow (tests/architect/flow-mass-apply-telegram.test.ts), one
// server per applicant tracking system, so each has its own origin (its own "host" for pacing), as in production:
//   greenhouse  the hosted board's application form as the boards API describes it (GET boards-api/v1/boards/{board}/jobs/
//               {id}?questions=true): first_name, last_name, email, phone, resume (file), question_<id> selects; posted as
//               multipart to the posting's own /submit; the boards API's questions JSON is served too.
//   lever       the jobs.lever.co/{company}/{id}/apply form: resume (file), name, email, phone, org, urls[LinkedIn],
//               cards[<uuid>][field0] (a custom card's select); posted as multipart to the same /apply URL, as Lever does.
//   ashby       the RECONSTRUCTED Ramp-shaped Ashby form (tests/fixtures/ramp), whose Submit sends one GraphQL mutation
//               (ApiSubmitSingleApplicationFormAction) carrying fieldEntries and the resume as base64.
// Every posting can be switched, per posting: `closed` (the page and its submit answer 404, "no longer accepting
// applications"), `captcha` (Ashby: a reCAPTCHA challenge frame at Submit, nothing sent; GH/Lever: a recaptcha widget on the
// form), `extraQuestion` (a NEW required question the form did not have when it was prepared). Every submission is recorded
// with its exact fields (and the resume bytes' sha256), and a repeat submission for the same posting answers 409.
// TEST fixtures, not real employers; nothing here reaches the network.
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export type Family = "greenhouse" | "lever" | "ashby";
export interface Posting { family: Family; board: string; id: string; company: string; title: string; closed?: boolean; captcha?: boolean; extraQuestion?: boolean }
export interface Submission { family: Family; board: string; id: string; fields: Record<string, string>; resume: { name: string; sha256: string } | null; at: number; status: number }

export const AUTH_Q = "Are you legally authorized to work in the United States?";
export const SPONSOR_Q = "Will you now or in the future require sponsorship for employment visa status?";
export const EXTRA_Q = "Which of our office locations would you work from?";
const GH_AUTH = 4100001, GH_SPONSOR = 4100002, GH_EXTRA = 4100009;
const LV_CARD = "8d3c3b0e-0001-4000-8000-00000000c001";

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
const select = (id: string, name: string, label: string, opts: string[]) =>
  `<label for="${id}">${esc(label)} <span>*</span></label><select id="${id}" name="${name}" required><option value="">Please select</option>${opts.map((o) => `<option value="${o}">${o}</option>`).join("")}</select>`;
// The voluntary self-identification section both ATSs append (optional; Trainee never answers it for the person).
const opt = (id: string, label: string, opts: string[]) =>
  `<label for="${id.replace(/\W/g, "_")}">${esc(label)}</label><select id="${id.replace(/\W/g, "_")}" name="${id}"><option value="">Please select</option>${opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>`;
const EEO = (g: string, r: string, v: string, d: string) => `<fieldset class="eeoc"><legend>Voluntary Self-Identification</legend>
${opt(g, "Gender", ["Male", "Female", "Decline To Self Identify"])}
${opt(r, "Race", ["Hispanic or Latino", "White", "Black or African American", "Asian", "Two or More Races", "Decline To Self Identify"])}
${opt(v, "Veteran Status", ["I am a veteran", "I am not a veteran", "I don't wish to answer"])}
${opt(d, "Disability Status", ["Yes, I have a disability", "No, I do not have a disability", "I do not want to answer"])}</fieldset>`;
const CLOSED = (p: Posting) => new Response(page("Not found", `<h1>This job is no longer accepting applications</h1><p>${esc(p.company)}</p>`), { status: 404, headers: { "content-type": "text/html" } });
// Lever loads hCaptcha on every form; a low score shows its visible challenge at Submit and nothing is posted (the
// loopback stand-in provider the engine knows, as the Ashby form's reCAPTCHA challenge).
const LEVER_CHALLENGE = `<script>document.getElementById("application-form").addEventListener("submit", (e) => { e.preventDefault();
  if (!document.querySelector("iframe[data-test-challenge]")) { const f = document.createElement("iframe"); f.setAttribute("data-test-challenge", "1");
  f.src = "/captcha-provider/hcaptcha/hcaptcha.html#frame=challenge"; f.style.width = "400px"; f.style.height = "580px"; document.body.appendChild(f); } });</script>`;
const RECAPTCHA = '<div class="g-recaptcha" data-sitekey="TEST-NEVER-SOLVED"></div>';

function ghForm(p: Posting, base: string) {
  const extra = p.extraQuestion ? `<label for="question_${GH_EXTRA}">${EXTRA_Q} <span>*</span></label><input id="question_${GH_EXTRA}" name="question_${GH_EXTRA}" type="text" required>` : "";
  return page(`Job Application for ${p.title} at ${p.company}`, `<h1 class="app-title">${esc(p.title)}</h1><span class="company-name">at ${esc(p.company)}</span>
<form id="application_form" method="post" action="${base}/${p.board}/jobs/${p.id}/submit" enctype="multipart/form-data">
<label for="first_name">First Name <span>*</span></label><input id="first_name" name="first_name" type="text" required>
<label for="last_name">Last Name <span>*</span></label><input id="last_name" name="last_name" type="text" required>
<label for="email">Email <span>*</span></label><input id="email" name="email" type="email" required>
<label for="phone">Phone <span>*</span></label><input id="phone" name="phone" type="tel" required>
<label for="resume">Resume/CV <span>*</span></label><input id="resume" name="resume" type="file" required>
${select(`question_${GH_AUTH}`, `question_${GH_AUTH}`, AUTH_Q, ["Yes", "No"])}
${select(`question_${GH_SPONSOR}`, `question_${GH_SPONSOR}`, SPONSOR_Q, ["Yes", "No"])}
<label for="question_4100010">How did you hear about us?</label><textarea id="question_4100010" name="question_4100010"></textarea>
${EEO("gender", "race", "veteran_status", "disability_status")}
${extra}${p.captcha ? RECAPTCHA : ""}<button type="submit" id="submit_app">Submit Application</button></form>`);
}
// The boards API's description of the same form (questions=true), the shape capture-greenhouse-questions.cjs saves.
function ghQuestions(p: Posting) {
  const q = (label: string, required: boolean, fields: unknown[]) => ({ label, required, fields });
  return {
    id: Number(p.id), title: p.title, absolute_url: `https://boards.greenhouse.io/${p.board}/jobs/${p.id}`, location: { name: "Chicago, IL" },
    questions: [
      q("First Name", true, [{ name: "first_name", type: "input_text", values: [] }]),
      q("Last Name", true, [{ name: "last_name", type: "input_text", values: [] }]),
      q("Email", true, [{ name: "email", type: "input_text", values: [] }]),
      q("Phone", true, [{ name: "phone", type: "input_text", values: [] }]),
      q("Resume/CV", true, [{ name: "resume", type: "input_file", values: [] }, { name: "resume_text", type: "textarea", values: [] }]),
      q(AUTH_Q, true, [{ name: `question_${GH_AUTH}`, type: "multi_value_single_select", values: [{ label: "Yes", value: 1 }, { label: "No", value: 0 }] }]),
      q(SPONSOR_Q, true, [{ name: `question_${GH_SPONSOR}`, type: "multi_value_single_select", values: [{ label: "Yes", value: 1 }, { label: "No", value: 0 }] }]),
      ...(p.extraQuestion ? [q(EXTRA_Q, true, [{ name: `question_${GH_EXTRA}`, type: "input_text", values: [] }])] : []),
    ],
  };
}
function lvForm(p: Posting, base: string) {
  const extra = p.extraQuestion ? `<label for="cards_extra">${EXTRA_Q} <span>*</span></label><input id="cards_extra" name="cards[${LV_CARD}][field1]" type="text" required>` : "";
  return page(`${p.company} - ${p.title}`, `<div class="posting-headline"><h2>${esc(p.title)}</h2></div><div class="main-header-logo">${esc(p.company)}</div>
<form id="application-form" method="post" action="${base}/${p.board}/${p.id}/apply" enctype="multipart/form-data">
<label for="resume-upload-input">Resume/CV <span>*</span></label><input id="resume-upload-input" name="resume" type="file" required>
<label for="name">Full name <span>*</span></label><input id="name" name="name" type="text" required>
<label for="email">Email <span>*</span></label><input id="email" name="email" type="email" required>
<label for="phone">Phone <span>*</span></label><input id="phone" name="phone" type="text" required>
<label for="org">Current company</label><input id="org" name="org" type="text">
<label for="urls_linkedin">LinkedIn URL</label><input id="urls_linkedin" name="urls[LinkedIn]" type="text">
${select("cards_auth", `cards[${LV_CARD}][field0]`, AUTH_Q, ["Yes", "No"])}
${EEO("eeo[gender]", "eeo[race]", "eeo[veteran]", "eeo[disability]")}
${extra}<button type="submit" id="btn-submit">Submit application</button></form>${p.captcha ? LEVER_CHALLENGE : ""}`);
}

// Ashby: the reconstructed form, its job id and organization replaced per posting; Submit as Ashby's script sends it.
const ASHBY_HTML = Deno.readTextFileSync(new URL("../fixtures/ramp/ashby-ramp-a13ae586-reconstructed.html", import.meta.url));
const ashbyScript = (p: Posting) => `<script>
document.querySelectorAll(".ashby-application-form-input-yesno").forEach((g) => g.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
  e.preventDefault(); g.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  const box = g.querySelector("input[type=checkbox]"); if (box) box.checked = b.dataset.option === "yes";
})));
document.querySelectorAll("input[role=combobox]").forEach((inp) => {
  const list = document.createElement("div"); list.setAttribute("role", "listbox"); inp.parentElement.appendChild(list);
  inp.addEventListener("input", () => { list.innerHTML = inp.value ? '<div role="option" tabindex="-1">' + inp.value.replace(/[<>&"]/g, "") + "</div>" : ""; inp.setAttribute("aria-expanded", String(!!inp.value));
    const o = list.firstElementChild; if (o) o.addEventListener("mousedown", (e) => { e.preventDefault(); inp.value = o.textContent; list.innerHTML = ""; inp.setAttribute("aria-expanded", "false"); }); });
});
document.querySelectorAll(".ashby-application-form-input-date").forEach((inp) => inp.addEventListener("blur", () => {
  const m = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(inp.value.trim());
  const ok = m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= new Date(+m[3], +m[1], 0).getDate();
  if (!ok) inp.value = "";
}));
document.querySelector(".ashby-application-form-submit-button").addEventListener("click", async (e) => {
  e.preventDefault();
  ${p.captcha ? `if (!document.querySelector("iframe[data-test-challenge]")) { const f = document.createElement("iframe"); f.setAttribute("data-test-challenge", "1");
    f.src = "/captcha-provider/recaptcha/enterprise/bframe"; f.style.width = "400px"; f.style.height = "580px"; document.body.appendChild(f); } return;` : ""}
  const fieldEntries = [];
  document.querySelectorAll(".ashby-application-form-field-entry").forEach((f) => {
    const field = f.dataset.fieldPath;
    if (field === "_systemfield_resume") return;
    const yes = f.querySelector("button[aria-pressed=true]");
    if (yes) { fieldEntries.push({ field, value: yes.dataset.option === "yes" }); return; }
    if (f.querySelector(".ashby-application-form-input-yesno")) return;
    const sel = f.querySelector("select"); if (sel) { if (sel.value) fieldEntries.push({ field, value: sel.value }); return; }
    const box = f.querySelector("input[type=checkbox]"); if (box) { if (box.checked) fieldEntries.push({ field, value: true }); return; }
    f.querySelectorAll("input[type=radio]:checked").forEach((r) => fieldEntries.push({ field: r.name, value: r.value }));
    const input = f.querySelector("input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea");
    if (input && input.value) fieldEntries.push({ field, value: input.value });
  });
  const file = document.querySelector("[data-field-path=_systemfield_resume] input[type=file]").files[0];
  let bin = ""; if (file) new Uint8Array(await file.arrayBuffer()).forEach((c) => { bin += String.fromCharCode(c); });
  const r = await fetch("/api/non-user-graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    operationName: "ApiSubmitSingleApplicationFormAction", query: "mutation ApiSubmitSingleApplicationFormAction { submit }",
    variables: { organizationHostedJobsPageName: ${JSON.stringify(p.board)}, jobPostingId: ${JSON.stringify(p.id)}, applicationForm: { fieldEntries },
      resume: file ? { name: file.name, content: btoa(bin) } : null } }) });
  if (r.ok) document.body.innerHTML = "<h1>Thank you for applying</h1><p>Application received. Confirmation number: ASHBY-" + ${JSON.stringify(p.id.slice(0, 8).toUpperCase())} + ".</p>";
});
</script>`;
const ashbyForm = (p: Posting) => ASHBY_HTML.replaceAll("Ramp", p.company).replace(/<\/body>/i, `${ashbyScript(p)}</body>`);

export function atsWorld(postings: Posting[], o: { latencyMs?: number } = {}) {
  const submissions: Submission[] = [], refused: string[] = [];
  const loads: Record<string, number> = {};
  const servers: Record<Family, { origin: string; close: () => Promise<void> }> = {} as any;
  const find = (family: Family, board: string, id: string) => postings.find((p) => p.family === family && p.board === board && p.id === id);
  const wait = () => o.latencyMs ? new Promise((r) => setTimeout(r, o.latencyMs)) : Promise.resolve();
  const record = async (s: Omit<Submission, "at" | "status">) => {
    const dup = submissions.some((x) => x.family === s.family && x.board === s.board && x.id === s.id && x.status === 200);
    const status = dup ? 409 : 200;
    submissions.push({ ...s, at: Date.now(), status });
    return status;
  };
  const multipart = async (req: Request) => {
    const data = await req.formData(), fields: Record<string, string> = {};
    let resume: Submission["resume"] = null;
    for (const [k, v] of data.entries()) {
      if (typeof v === "string") fields[k] = v;
      else if (v.size || v.name) resume = { name: v.name, sha256: await hex(new Uint8Array(await v.arrayBuffer())) };
    }
    return { fields, resume };
  };
  const serve = (family: Family, handler: (req: Request, u: URL, base: string) => Promise<Response>) => {
    let base = "";
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
      const u = new URL(req.url);
      loads[`${family} ${req.method} ${u.pathname}`] = (loads[`${family} ${req.method} ${u.pathname}`] ?? 0) + 1;
      await wait();
      return await handler(req, u, base);
    });
    base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
    servers[family] = { origin: base, close: () => server.shutdown() };
  };
  serve("greenhouse", async (req, u, base) => {
    let m = /^\/v1\/boards\/([\w-]+)\/jobs\/(\d+)$/.exec(u.pathname);
    if (req.method === "GET" && m) { const p = find("greenhouse", m[1], m[2]); return p && !p.closed ? Response.json(ghQuestions(p)) : Response.json({ status: 404, error: "Job not found" }, { status: 404 }); }
    m = /^\/([\w-]+)\/jobs\/(\d+)(\/submit)?$/.exec(u.pathname);
    const p = m ? find("greenhouse", m[1], m[2]) : undefined;
    if (!m || !p) return new Response("not found", { status: 404 });
    if (p.closed) { if (req.method === "POST") refused.push(`greenhouse ${p.id} closed`); return CLOSED(p); }
    if (req.method === "GET" && !m[3]) return new Response(ghForm(p, base), { headers: { "content-type": "text/html" } });
    if (req.method === "POST" && m[3]) {
      const { fields, resume } = await multipart(req);
      const status = await record({ family: "greenhouse", board: p.board, id: p.id, fields, resume });
      return new Response(status === 200 ? page("Thank you", `<h1>Thank you for applying.</h1><p id="application_confirmation">Your application has been submitted. Confirmation code GH-${p.id}.</p>`) : page("Duplicate", "<h1>Already applied</h1>"),
        { status, headers: { "content-type": "text/html" } });
    }
    return new Response("method not allowed", { status: 405 });
  });
  serve("lever", async (req, u, base) => {
    if (u.pathname.startsWith("/captcha-provider/")) return new Response("<p>Select all images with a boat</p>", { headers: { "content-type": "text/html" } });
    const m = /^\/([\w-]+)\/([0-9a-f-]{36})(\/apply)?$/.exec(u.pathname);
    const p = m ? find("lever", m[1], m[2]) : undefined;
    if (!m || !p) return new Response("not found", { status: 404 });
    if (p.closed) { if (req.method === "POST") refused.push(`lever ${p.id} closed`); return CLOSED(p); }
    if (req.method === "GET") return new Response(lvForm(p, base), { headers: { "content-type": "text/html" } });
    if (req.method === "POST" && m[3]) {
      const { fields, resume } = await multipart(req);
      const status = await record({ family: "lever", board: p.board, id: p.id, fields, resume });
      return new Response(status === 200 ? page("Application submitted", `<h1>Application submitted!</h1><p>Thanks for applying to ${esc(p.company)}. We've received your application. Reference LV-${p.id.slice(0, 8).toUpperCase()}.</p>`) : page("Duplicate", "<h1>Already applied</h1>"),
        { status, headers: { "content-type": "text/html" } });
    }
    return new Response("method not allowed", { status: 405 });
  });
  serve("ashby", async (req, u) => {
    if (u.pathname.startsWith("/captcha-provider/")) return new Response("<p>Select all images with a bus</p>", { headers: { "content-type": "text/html" } });
    if (req.method === "POST" && u.pathname === "/api/non-user-graphql") {
      const body = await req.json().catch(() => ({}));
      if (!/^ApiSubmit/.test(String(body?.operationName))) return Response.json({ data: {} });
      const v = body.variables ?? {};
      const p = find("ashby", String(v.organizationHostedJobsPageName), String(v.jobPostingId));
      if (!p || p.closed) { refused.push(`ashby ${v.jobPostingId} closed`); return Response.json({ errors: [{ message: "Job posting not found" }] }, { status: 404 }); }
      const fields: Record<string, string> = {};
      for (const e of v.applicationForm?.fieldEntries ?? []) fields[e.field] = typeof e.value === "string" ? e.value : JSON.stringify(e.value);
      const bytes = v.resume?.content ? Uint8Array.from(atob(v.resume.content), (c) => c.charCodeAt(0)) : null;
      const status = await record({ family: "ashby", board: p.board, id: p.id, fields, resume: bytes ? { name: String(v.resume.name), sha256: await hex(bytes) } : null });
      return status === 200 ? Response.json({ data: { ok: true } }) : Response.json({ errors: [{ message: "Already applied" }] }, { status });
    }
    if (req.method === "GET" && u.pathname.startsWith("/posting-api/job-board/")) {
      const board = u.pathname.split("/").pop()!;
      return Response.json({ apiVersion: "1", jobs: postings.filter((p) => p.family === "ashby" && p.board === board && !p.closed).map((p) => ({ id: p.id, title: p.title, location: "Chicago, IL", isListed: true, publishedAt: new Date().toISOString() })) });
    }
    const m = /^\/([\w-]+)\/([0-9a-f-]{36})\/application$/.exec(u.pathname);
    const p = m ? find("ashby", m[1], m[2]) : undefined;
    if (!p) return new Response("not found", { status: 404 });
    if (p.closed) return CLOSED(p);
    return new Response(ashbyForm(p), { headers: { "content-type": "text/html" } });
  });
  const urlOf = (p: Posting) => p.family === "greenhouse" ? `${servers.greenhouse.origin}/${p.board}/jobs/${p.id}`
    : p.family === "lever" ? `${servers.lever.origin}/${p.board}/${p.id}` : `${servers.ashby.origin}/${p.board}/${p.id}/application`;
  return {
    servers, submissions, refused, loads, urlOf,
    origin: (f: Family) => servers[f].origin,
    sent: (p: Posting) => submissions.filter((s) => s.family === p.family && s.board === p.board && s.id === p.id),
    close: async () => { for (const s of Object.values(servers)) await s.close(); },
  };
}
export type AtsWorld = ReturnType<typeof atsWorld>;
