"use strict";
// Recruitee, Teamtailor and Personio pages as the strict benchmark met them (DOM dump run 42735927546), on local fixtures:
//  - Teamtailor's job page carries a Connect sign-in form (hidden token, honeypot "email without domain", a "Log in" button):
//    it is never the application, its Log in is never the Submit, and a page with only that form is no pass;
//  - Teamtailor's Apply worded "Enviar solicitud" / "Skicka ansökan" (no form owner) opens the real form;
//  - Recruitee /c/new in Dutch and Latvian, two submit-typed buttons, Submit worded "Versturen" / "Sūtīt";
//  - Personio's Spanish "Solicitar este puesto de trabajo";
//  - a 429 on the apply address is reported as page_load_429, not "no form".
// Nothing is ever posted (the server counts every non-GET).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting, paceKey, falsePass } = require("../scripts/browser-eval/strict.cjs");
const { factValue } = require("../workers/career-browser/ats-fill.cjs");
const { APPLY_TEXT, NEVER_CLICK, SEND_APPLY } = require("../workers/career-browser/apply-entry.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
let browser, server, base;
const posts = [];

const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
// Teamtailor's Connect form, as dumped: hidden inputs, a honeypot at opacity 0 out of the tab order, one visible Log in.
const CONNECT = (label) => `<form action="/es/auto_join" method="post"><input type="hidden" name="authenticity_token" value="t"><input type="hidden" name="domain" value="x.example">
  <input type="hidden" name="email"><label for="full_email">${label}</label><input type="email" name="full_email" id="full_email" required tabindex="-1" autocomplete="off" style="opacity:0;position:absolute;width:500px;height:48px">
  <button type="submit">Iniciar sesión</button></form>`;
const TT_FORM = `<form action="/applications" method="post" class="job-application-form"><label for="fn">Nombre*</label><input id="fn" name="candidate[first_name]" required>
  <label for="ln">Apellidos*</label><input id="ln" name="candidate[last_name]" required><label for="em">Correo electrónico*</label><input id="em" type="email" name="candidate[email]" required>
  <button type="submit">Enviar solicitud</button></form>`;
const TT_JOB = (words) => page(`<h1>Puesto</h1><button id="a1">${words}</button><p>texto</p><button id="a2">${words}</button><div id="slot"></div>${CONNECT("Dirección de correo electrónico sin dominio")}
  <script>for (const id of ["a1","a2"]) document.getElementById(id).addEventListener("click", () => { document.getElementById("slot").innerHTML = ${JSON.stringify(TT_FORM)}; });</script>`);
const RC_FORM = (L) => page(`<form class="offer-application-form"><fieldset><legend>${L.legend}</legend>
  <label for="n">${L.name} *</label><input id="n" name="candidate.name" required autocomplete="name">
  <label for="e">${L.email} *</label><input id="e" type="email" name="candidate.email" required>
  <label for="p">${L.phone} *</label><input id="p" type="tel" name="candidate.phone" required></fieldset>
  <section><label for="cv">${L.cv} *</label><input id="cv" type="file" name="candidate.cv" required style="opacity:0;width:518px;height:125px"></section>
  <section><label for="cl">${L.letter}</label><input id="cl" type="file" name="candidate.coverLetterFile" style="opacity:0;width:518px;height:125px"><button type="submit">${L.instead}</button></section>
  <div><button type="submit">${L.send}</button></div></form>`);
const NL = { legend: "Mijn informatie", name: "Volledige naam", email: "E-mailadres", phone: "Telefoonnummer", cv: "Cv", letter: "Motivatiebrief", instead: "Schrijf je motivatiebrief in plaats daarvan hier", send: "Versturen" };
const LV = { legend: "Mana informācija", name: "Vārds Uzvārds", email: "E-pasta adrese", phone: "Tālruņa numurs", cv: "CV/Pieteikums", letter: "Motivācijas vēstule", instead: "Tā vietā uzrakstiet to šeit", send: "Sūtīt" };
const routes = {
  "/tt/jobs/1-es": () => TT_JOB("Enviar solicitud"),
  "/tt/jobs/2-sv": () => TT_JOB("Skicka ansökan"),
  "/tt/jobs/3-connect-only": () => page(`<h1>Puesto</h1>${CONNECT("Email address without domain")}`),
  // Teamtailor's real form: the file box hands the file to a presigned upload (a POST the dry run aborts) and goes away.
  "/tt/jobs/4-upload": () => page(`<form action="/applications" method="post"><label for="fn">First name*</label><input id="fn" name="candidate[first_name]" required>
    <label for="em">Email*</label><input id="em" type="email" name="candidate[email]" required>
    <div class="up"><label for="cv">Upload CV*Required</label><input id="cv" type="file" required style="opacity:0;width:600px;height:60px"></div><button type="submit">Send application</button></form>
    <script>document.getElementById("cv").addEventListener("change", (e) => { fetch("/uploads/presigned_data", { method: "POST", body: "{}" }).catch(() => {}); e.target.remove(); });</script>`),
  // Personio-like: once the resume is attached the form inserts a box at its top; answers already filled keep their numbers.
  "/job/88/apply": () => page(`<form id="f"><label for="a">Vorname *</label><input id="a" name="first_name" required><label for="b">Nachname *</label><input id="b" name="last_name" required>
    <label for="c">E-Mail *</label><input id="c" type="email" name="email" required><label for="cv">Lebenslauf *</label><input id="cv" type="file" name="cv" required>
    <button type="submit">Bewerbung senden</button></form>
    <script>document.getElementById("cv").addEventListener("change", () => { const l = document.createElement("label"); l.htmlFor = "x"; l.textContent = "Weitere Dokumente"; const i = document.createElement("input"); i.id = "x"; i.name = "other"; const f = document.getElementById("f"); f.prepend(i); f.prepend(l); });</script>`),
  "/o/nl": () => page(`<h1>Vacature</h1><button type="button">Solliciteren</button>`),
  "/o/nl/c/new": () => RC_FORM(NL),
  "/o/lv": () => page(`<h1>Vakance</h1>`),
  "/o/lv/c/new": () => RC_FORM(LV),
  "/o/busy": () => page(`<h1>Vacature</h1>`),
  "/job/77": () => page(`<h1>Especialista</h1><a href="/job/77/apply">Solicitar este puesto de trabajo</a><button>Solicitar este puesto de trabajo</button>`),
  "/job/77/apply": () => page(`<form><label for="a">Nombre *</label><input id="a" name="first_name" required><label for="b">Apellido *</label><input id="b" name="last_name" required>
    <label for="c">Correo electrónico *</label><input id="c" type="email" name="email" required><button type="submit">Enviar candidatura</button></form>`),
};
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return res.writeHead(200).end("ok"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (req.url === "/o/busy/c/new") return res.writeHead(429, { "content-type": "text/html" }).end("<title>429</title>");
    const r = routes[req.url];
    if (r) return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(r());
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const opts = () => ({ robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "eu-"))) });
const run = (provider, p) => strictPosting(browser, { provider, url: `${base}${p}` }, opts());

test("Teamtailor: the Spanish and Swedish Apply opens the real form; the sign-in form beside it is never filled or pressed", { skip }, async () => {
  for (const p of ["/tt/jobs/1-es", "/tt/jobs/2-sv"]) {
    const r = await run("teamtailor", p);
    assert.equal(r.result, "pass", `${p} ${JSON.stringify(r)}`);
  }
  assert.deepEqual(posts, []);
});

test("Teamtailor: a page whose only form is the Connect sign-in is not a pass (nothing to apply with; Log in never pressed)", { skip }, async () => {
  const r = await run("teamtailor", "/tt/jobs/3-connect-only");
  assert.equal(r.result, "fail", JSON.stringify(r));
  assert.equal(r.reason, "no_application_form_found");
  assert.deepEqual(posts, []);
});

test("Recruitee: Dutch and Latvian /c/new forms with two submit-typed buttons reach the instant before Versturen / Sūtīt", { skip }, async () => {
  for (const p of ["/o/nl", "/o/lv"]) {
    const r = await run("recruitee", p);
    assert.equal(r.result, "pass", `${p} ${JSON.stringify(r)}`);
  }
  assert.deepEqual(posts, []);
});

test("Recruitee: a 429 on the apply address is reported as that, not as 'no form'", { skip }, async () => {
  const r = await run("recruitee", "/o/busy");
  assert.equal(r.result, "fail");
  assert.equal(r.reason, "retries_exhausted", JSON.stringify(r));
  assert.match(String(r.error), /page_load_429/);
});

test("Personio: the Spanish 'Solicitar este puesto de trabajo' link opens the form", { skip }, async () => {
  const r = await run("personio", "/job/77");
  assert.equal(r.result, "pass", JSON.stringify(r));
  assert.deepEqual(posts, []);
});

test("label rules: Dutch, Latvian and Lithuanian contact labels map to the confirmed facts; a honeypot label maps to none", () => {
  const f = { full_name: "Testy Example", email: "t@example.invalid", phone: "+1 555 0100" };
  assert.equal(factValue("E-mailadres *", f), f.email);
  assert.equal(factValue("E-pasta adrese", f), f.email);
  assert.equal(factValue("El. pašto adresas", f), f.email);
  assert.equal(factValue("Vārds Uzvārds", f), f.full_name);
  assert.equal(factValue("Tālruņa numurs", f), f.phone);
  assert.equal(factValue("Telefono numeris", f), f.phone);
  assert.equal(factValue("Dirección de correo electrónico sin dominio", f), undefined);
  assert.equal(factValue("E-mailadres van je referentie", f), undefined);
});

test("apply words: send-worded Apply is only the two Teamtailor phrases; a Submit word stays never-click", () => {
  for (const t of ["Enviar solicitud", "Skicka ansökan", "Solicitar este puesto de trabajo"]) assert.ok(APPLY_TEXT.test(t), t);
  assert.ok(SEND_APPLY.test("Enviar solicitud") && SEND_APPLY.test("Skicka ansökan"));
  for (const t of ["Enviar", "Enviar candidatura", "Skicka", "Submit application", "Send"]) { assert.ok(NEVER_CLICK.test(t), t); assert.ok(!SEND_APPLY.test(t), t); }
  assert.equal(paceKey("acme.recruitee.com"), "recruitee.com");
  assert.equal(paceKey("jobs.demv-systems.de"), "jobs.demv-systems.de");
});

test("a board that uploads the resume before Submit is 'ready except upload', never a pass; the upload POST is aborted", { skip }, async () => {
  const r = await run("teamtailor", "/tt/jobs/4-upload");
  assert.equal(r.result, "ready_except_upload", JSON.stringify(r));
  assert.ok(r.sent_blocked >= 1);
  assert.deepEqual(posts, []);
});

test("a stop at Submit is a pass only with a person field read back, a Submit that is no login, and no password box", () => {
  const facts = lib.TEST_FACTS;
  const email = { source: "fact", approved: facts.email, held: facts.email };
  assert.equal(falsePass({ fields: [email], submit: "Send application", password_field: false }, facts), null);
  assert.equal(falsePass({ fields: [], submit: "Log in", password_field: false }, facts), "no_person_field_read_back");
  assert.equal(falsePass({ fields: [{ ...email, held: "" }], submit: "Send", password_field: false }, facts), "no_person_field_read_back");
  assert.equal(falsePass({ fields: [{ source: "resume", approved: "cv.pdf", held: "cv.pdf" }], submit: "Send", password_field: false }, facts), "no_person_field_read_back");
  for (const w of ["Log in", "Iniciar sesión", "Sign in", "Prisijungti", "Anmelden"]) assert.equal(falsePass({ fields: [email], submit: w, password_field: false }, facts), "submit_is_login", w);
  assert.equal(falsePass({ fields: [email], submit: "Submit", password_field: true }, facts), "password_field_shown");
  assert.equal(falsePass(undefined, facts), "no_audit");
});

test("a box that appears after the upload does not renumber filled answers: the last look reads the person's own fields", { skip }, async () => {
  const r = await run("personio", "/job/88/apply");
  assert.equal(r.result, "pass", JSON.stringify({ reason: r.reason, audit: r.audit }));
  assert.deepEqual(posts, []);
});
