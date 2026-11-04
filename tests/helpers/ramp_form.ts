// A local stand-in for Ramp's Ashby job board and its application form (tests/fixtures/ramp, RECONSTRUCTED, not
// captured), on 127.0.0.1. Ashby's own script is reduced to what the form needs: a yes/no button presses itself and sets
// its hidden box; an autocomplete box offers what was typed as its one option; the date box keeps a MM/DD/YYYY date as
// react-datepicker does (anything else is cleared); Submit sends the application as one GraphQL mutation. With
// `challenge`, Submit shows a visible reCAPTCHA challenge frame (the local provider stand-in the engine knows) and sends
// nothing, as a low reCAPTCHA Enterprise score does. Nothing here reaches Ramp or Ashby.
export const RAMP_JOB = "a13ae586-f4cb-4385-8822-c42b9b54ed74";
export const RAMP_LINK = `https://jobs.ashbyhq.com/ramp/${RAMP_JOB}`;
export const RAMP_KEY = `ashby:ramp:${RAMP_JOB}`;
export const RAMP_TITLE = "Software Engineering Intern, Frontend";

const SCRIPT = (challenge: boolean) => `<script>
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
  ${challenge ? `if (!document.querySelector("iframe[data-test-challenge]")) { const f = document.createElement("iframe"); f.setAttribute("data-test-challenge", "1");
    f.src = "/captcha-provider/recaptcha/enterprise/bframe"; f.style.width = "400px"; f.style.height = "580px"; document.body.appendChild(f); } return;` : ""}
  const fieldEntries = [];
  document.querySelectorAll(".ashby-application-form-field-entry").forEach((f) => {
    const field = f.dataset.fieldPath;
    if (field === "_systemfield_resume") return;
    const yes = f.querySelector("button[aria-pressed=true]");
    // Ashby's yes/no answer travels as a boolean.
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
    variables: { organizationHostedJobsPageName: "ramp", jobPostingId: ${JSON.stringify(RAMP_JOB)}, applicationForm: { fieldEntries },
      resume: file ? { name: file.name, content: btoa(bin) } : null } }) });
  if (r.ok) document.body.innerHTML = "<h1>Thank you for applying</h1><p>Application received. Confirmation number: RAMP-TEST-5120.</p>";
});
</script>`;

export function rampSite(o: { challenge?: boolean } = {}) {
  const applications: any[] = [], other: string[] = [];
  let challenge = !!o.challenge;
  const html = Deno.readTextFileSync(new URL("../fixtures/ramp/ashby-ramp-a13ae586-reconstructed.html", import.meta.url));
  const form = () => html.replace(/<\/body>/i, `${SCRIPT(challenge)}</body>`);
  const board = { apiVersion: "1", jobs: [{
    id: RAMP_JOB, title: RAMP_TITLE, location: "New York, NY", departmentName: "Engineering", employmentType: "Intern", isListed: true,
    publishedAt: new Date().toISOString(), jobUrl: RAMP_LINK, applyUrl: `${RAMP_LINK}/application`,
    descriptionPlain: "TEST synthetic posting standing in for Ramp's. Build product UI in React and TypeScript with the frontend team.",
  }] };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/posting-api/job-board/ramp") return Response.json(board);
    if (req.method === "GET" && u.pathname === `/ramp/${RAMP_JOB}/application`) return new Response(form(), { headers: { "content-type": "text/html" } });
    if (u.pathname.startsWith("/captcha-provider/")) return new Response("<p>Select all images with a bus</p>", { headers: { "content-type": "text/html" } });
    if (req.method === "POST" && u.pathname === "/api/non-user-graphql") {
      const body = await req.json().catch(() => ({}));
      if (/^ApiSubmit/.test(String(body?.operationName))) applications.push(body); else other.push(String(body?.operationName));
      return Response.json({ data: { ok: true } });
    }
    other.push(`${req.method} ${u.pathname}`);
    return new Response("not found", { status: 404 });
  });
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { origin, form: `${origin}/ramp/${RAMP_JOB}/application`, applications, other, close: () => server.shutdown(),
    setChallenge: (on: boolean) => { challenge = on; } };
}
