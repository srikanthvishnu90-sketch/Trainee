// An Ashby-shaped stand-in for Ramp's posting a13ae586 (Software Engineering Intern, Frontend), on 127.0.0.1, closer to
// the live page than tests/helpers/ramp_form.ts in the three ways the live page differs:
//   1. the form is not in the HTML: the page first asks Ashby's GraphQL for the posting (a read-only query, ApiJobPosting,
//      POST /api/non-user-graphql?op=ApiJobPosting), and only then shows the form;
//   2. Submit sends one GraphQL multipart request (the GraphQL multipart request spec Ashby's client uses): an
//      `operations` part holding ApiSubmitSingleApplicationFormAction with the field entries, a `map` part, and the resume
//      as a real file part "0", to /api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction;
//   3. reCAPTCHA Enterprise can show its challenge at load or at Submit (`challenge: "open" | "submit"`).
// The fields are the reconstructed copy's (tests/fixtures/ramp/ashby-ramp-a13ae586-reconstructed.html: labels, required
// marks and widget kinds read from the live page in the owner's browser on 2026-10-25); the live Ashby API was not
// reachable from the build container (egress refused), so no live schema was fetched. Nothing here reaches Ramp or Ashby.
export const RAMP_JOB = "a13ae586-f4cb-4385-8822-c42b9b54ed74";
export const RAMP_LINK = `https://jobs.ashbyhq.com/ramp/${RAMP_JOB}`;

export type AshbyField = { path: string; title: string; required: boolean };
export type Sent = { url: string; operations: any; map: any; files: { part: string; name: string; bytes: Uint8Array }[] };

const HTML = new URL("../fixtures/ramp/ashby-ramp-a13ae586-reconstructed.html", import.meta.url);

// The posting's form as Ashby's ApiJobPosting answer carries it (field path, title, required), read from the copy.
export function rampSchema(html = Deno.readTextFileSync(HTML)): AshbyField[] {
  const out: AshbyField[] = [];
  const re = /data-field-path="([^"]+)"[^>]*>([\s\S]*?)(?=<div class="_fieldEntry|<\/div><textarea id="g-recaptcha|$)/g;
  for (const m of html.matchAll(re)) {
    const title = /ashby-application-form-question-title"[^>]*>([^<]*)</.exec(m[2])?.[1] ??
      /<legend[^>]*>([^<]*)</.exec(m[2])?.[1] ?? /class="[^"]*_heading[^"]*"[^>]*>([^<]*)</.exec(m[2])?.[1] ?? "";
    out.push({ path: m[1], title: title.trim(), required: /_required_/.test(m[2].slice(0, 400)) });
  }
  return out;
}

const SCRIPT = (challenge: "" | "open" | "submit", mode: string) => `<script>
const CHALLENGE = ${JSON.stringify(challenge)}, MODE = ${JSON.stringify(mode)};
const form = document.querySelector(".ashby-application-form-container");
form.style.display = "none";
const challengeFrame = () => { if (document.querySelector("iframe[data-test-challenge]")) return; const f = document.createElement("iframe");
  f.setAttribute("data-test-challenge", "1"); f.src = "/captcha-provider/recaptcha/enterprise/bframe"; f.style.width = "400px"; f.style.height = "580px"; document.body.appendChild(f); };
fetch("/api/non-user-graphql?op=ApiJobPosting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  operationName: "ApiJobPosting", query: "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting { applicationForm { sections { fieldEntries { field isRequired } } } } }",
  variables: { organizationHostedJobsPageName: "ramp", jobPostingId: ${JSON.stringify(RAMP_JOB)} } }) }).then((r) => r.json()).then((d) => {
  const known = new Set(d.data.jobPosting.applicationForm.sections.flatMap((s) => s.fieldEntries.map((e) => e.field.path)));
  document.querySelectorAll(".ashby-application-form-field-entry").forEach((f) => { if (!known.has(f.dataset.fieldPath)) f.remove(); });
  form.style.display = "";
  if (CHALLENGE === "open") challengeFrame();
});
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
  if (CHALLENGE === "submit") { challengeFrame(); return; }
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
    if (input && input.value) fieldEntries.push({ field, value: MODE === "tamper" && field === "_systemfield_email" ? "changed-by-page@example.test" : input.value });
  });
  const file = document.querySelector("[data-field-path=_systemfield_resume] input[type=file]").files[0];
  const operations = { operationName: "ApiSubmitSingleApplicationFormAction", query: "mutation ApiSubmitSingleApplicationFormAction($resume: Upload) { submitSingleApplicationFormAction { applicationFormResult { __typename } } }",
    variables: { organizationHostedJobsPageName: "ramp", jobPostingId: ${JSON.stringify(RAMP_JOB)}, applicationForm: { fieldEntries }, resume: null,
      recaptchaToken: document.querySelector("[name=g-recaptcha-response]").value || null } };
  const body = new FormData();
  body.append("operations", JSON.stringify(operations));
  body.append("map", JSON.stringify({ "0": ["variables.resume"] }));
  if (file) body.append("0", file, file.name);
  const r = await fetch("/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction", { method: "POST", body });
  if (r.ok) document.body.innerHTML = "<h1>Thank you for applying</h1><p>Your application was submitted. Confirmation number: RAMP-ASHBY-0931.</p>";
});
</script>`;

export function ashbyLiveShapeSite(o: { challenge?: "" | "open" | "submit"; mode?: string } = {}) {
  const applications: Sent[] = [], reads: string[] = [], other: string[] = [];
  let challenge = o.challenge ?? "", mode = o.mode ?? "";
  const html = Deno.readTextFileSync(HTML);
  const schema = rampSchema(html);
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === `/ramp/${RAMP_JOB}/application`) {
      return new Response(html.replace(/<\/body>/i, `${SCRIPT(challenge as any, mode)}</body>`), { headers: { "content-type": "text/html" } });
    }
    if (u.pathname.startsWith("/captcha-provider/")) return new Response("<p>Select all images with a bus</p>", { headers: { "content-type": "text/html" } });
    if (req.method === "POST" && u.pathname === "/api/non-user-graphql") {
      const type = req.headers.get("content-type") || "";
      if (type.startsWith("multipart/form-data")) {
        const fd = await req.formData();
        const files: Sent["files"] = [];
        for (const [k, v] of fd.entries()) if (typeof v !== "string") files.push({ part: k, name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) });
        const operations = JSON.parse(String(fd.get("operations") ?? "null")), map = JSON.parse(String(fd.get("map") ?? "null"));
        if (/^ApiSubmit/.test(String(operations?.operationName))) {
          applications.push({ url: u.pathname + u.search, operations, map, files });
          return Response.json({ data: { submitSingleApplicationFormAction: { applicationFormResult: { __typename: "FormSubmitSuccess" } } } });
        }
        other.push(`multipart ${operations?.operationName}`);
        return Response.json({ errors: [{ message: "unknown" }] }, { status: 400 });
      }
      const body = await req.json().catch(() => ({}));
      if (body?.operationName === "ApiJobPosting") {
        reads.push("ApiJobPosting");
        return Response.json({ data: { jobPosting: { id: RAMP_JOB, title: "Software Engineering Intern, Frontend", applicationForm: { sections: [{
          fieldEntries: schema.map((f) => ({ field: { path: f.path, title: f.title }, isRequired: f.required })) }] } } } });
      }
      other.push(`json ${body?.operationName}`);
      return Response.json({ data: null });
    }
    other.push(`${req.method} ${u.pathname}`);
    return new Response("not found", { status: 404 });
  });
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return {
    origin, form: `${origin}/ramp/${RAMP_JOB}/application`, schema, applications, reads, other,
    set: (x: { challenge?: "" | "open" | "submit"; mode?: string }) => { if (x.challenge !== undefined) challenge = x.challenge; if (x.mode !== undefined) mode = x.mode; },
    close: () => server.shutdown(),
  };
}
