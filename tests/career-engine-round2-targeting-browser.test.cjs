"use strict";
// Round 2 (review of #818), click and fill targeting in Chromium, through the real runner (parallel-apply applyOne). The pages
// are the reviewer's adversarial shapes, on 127.0.0.1; what was pressed, typed and posted is read from the server's own record
// (tests/fixtures/engine-round2/harness.cjs). A refusal is always fine; a wrong press, a wrong fill or a wrong post is the failure.
// The rules on plain data: tests/career-engine-round2-targeting.test.cjs.
// Run: node --test tests/career-engine-round2-targeting-browser.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, st, doc, F, F3, SUB, skip } = require("./fixtures/engine-round2/harness.cjs");

const P = st.pages, o = { skip, timeout: 240000 };
const app = (id, inner) => `<form id="app" action="/${id}/submit" method="post" enctype="multipart/form-data">${inner}</form>`;
const CHECK = `<div class="g-recaptcha" data-sitekey="6L-TEST" style="width:304px;height:78px;border:1px solid #ccc">[box]</div>`;
const pages = (o2) => { for (const [k, v] of Object.entries(o2)) P["/" + k] = typeof v === "function" ? () => doc(k, v()) : doc(k, v); return Object.keys(o2); };
let h;
before(async () => { if (!skip) h = await start(); });
after(async () => { if (h) await h.stop(); });
const untouched = (x, id) => { assert.notEqual(x.r.status, "submitted_page_confirmed", `${id} ${JSON.stringify(x.r)}`); assert.deepEqual(x.posts, [], `${id}: nothing posted`); };

// ---- 1. the Submit label
const only = Object.fromEntries(["Save for later", "Withdraw application", "Apply with LinkedIn", "Delete my data", "Next", "Create account"].map((w, i) =>
  [`only${i}`, app(`only${i}`, F + `<button data-k="IN:${w}">${w}</button><div class="btn" onclick="this.closest('form').submit()">Submit application</div>`)]));
const LABELS = pages({ ...only,
  two: app("two", F + `<button type="submit" name="a" value="acct" data-k="IN:acct">Apply</button><button type="submit" name="a" value="plain" data-k="IN:plain">Submit</button>`),
  disagree: app("disagree", F + `<button type="button" data-k="IN:save" aria-label="Submit application">Save draft</button><button type="submit" data-k="IN:del" aria-label="Delete application">Submit</button>`),
  icon: app("icon", F + `<button type="button" data-k="IN:trash" aria-label="Submit application"><svg width="20" height="20"></svg></button><button type="submit" data-k="IN:real"><svg width="20" height="20"></svg></button>`),
  disabled: app("disabled", F + `<button type="submit" disabled>Submit application</button>`),
  feedback: `<main>${app("feedback", F)}</main><footer><p>Was this page helpful?</p><div contenteditable="true" style="border:1px solid;width:200px;height:20px"></div><button type="button" data-k="OUT:feedback">Submit</button></footer>`,
  header: `<header><button type="button" data-k="OUT:header-apply">Apply</button></header><main>${app("header", F)}</main>` });
test("1: a button in none of the Submit words is never pressed, two candidates or disagreeing names refuse, and nothing is typed first", o, async () => {
  for (const id of LABELS) {
    const x = await h.run("/" + id);
    untouched(x, id); assert.deepEqual(x.clicks, [], `${id}: nothing pressed`); assert.deepEqual(x.typed, [], `${id}: nothing typed`);
  }
  assert.equal((await h.run("/two")).r.reason, "ambiguous_submit"); assert.equal((await h.run("/disagree")).r.reason, "ambiguous_submit");
});

// ---- 2. LinkedIn / Indeed
const LI = pages({
  liAria: app("liAria", F) + `<button type="button" data-k="OUT:li" aria-label="Apply with LinkedIn" onclick="location.href='https://www.linkedin.com/oauth/apply'"><img alt="in" width="16" height="16">Apply</button>`,
  liLink: `<a href="https://www.linkedin.com/jobs/view/123/apply" data-k="OUT:li">Apply</a>`,
  indeedLink: `<a href="https://www.indeed.com/applystart?jk=1" data-k="OUT:indeed">Apply now</a>`,
  liData: `<button type="button" data-k="OUT:li" data-provider="linkedin">Apply</button>`,
  liImg: `<button type="button" data-k="OUT:li"><img alt="LinkedIn" width="16" height="16"> Apply</button>`,
  liIn: app("liIn", F + `<button data-k="IN:li">Apply with LinkedIn</button>`) });
test("2: nothing that names LinkedIn or Indeed, or leads there, is ever pressed", o, async () => {
  for (const id of LI) { const x = await h.run("/" + id); untouched(x, id); assert.deepEqual(x.clicks, [], `${id}: nothing pressed`); }
  // The page's own Apply link beside an Indeed one is still opened, and the Indeed one is not.
  pages({ both: `<a href="https://www.indeed.com/applystart?jk=1" data-k="OUT:indeed">Apply now</a><a href="/own" data-k="OUT:own">Apply</a>`, own: app("own", F + SUB) });
  const x = await h.run("/both");
  assert.equal(x.r.status, "submitted_page_confirmed", JSON.stringify(x.r)); assert.ok(!x.clicks.includes("OUT:indeed")); assert.deepEqual(x.posts.map((p) => p.path), ["/own/submit"]);
});

// ---- 3. which form is the application
const other = (action, head, fields, btn) => `<form action="${action}" method="post"><h3>${head}</h3>${fields}<button type="submit">${btn}</button></form>`;
const NAME = (p) => `<label>First Name <input name="${p}_first"></label><label>Last Name <input name="${p}_last"></label><label>Email <input type="email" name="${p}_email"></label>`;
const BESIDE = pages({
  besideSearch: other("/search", "", `<label>Keyword <input name="search_q"></label><label>Location <input name="search_loc"></label>`, "Find jobs") + app("besideSearch", F + SUB),
  besideReturning: other("/account", "Returning candidate", `<label>First Name <input name="login_first"></label><label>Email <input type="email" name="login_email"></label>`, "Continue") + app("besideReturning", F + SUB),
  besideFriend: other("/refer", "Refer a friend", `<label>Name <input name="ref_name"></label><label>Email <input type="email" name="ref_email"></label>`, "Send") + app("besideFriend", F + SUB) });
const ALONE = pages({
  demo: `<a href="/real" data-k="OUT:apply">Apply</a><footer>${other("/contact", "Talk to sales", NAME("contact") + `<label>Company <input name="contact_company"></label>`, "Request a demo")}</footer>`,
  talent: `<a href="/real" data-k="OUT:apply">Apply</a>${other("/talent", "Join our talent community", NAME("tc"), "Join")}`,
  frame: () => `<iframe src="${st.base.replace("127.0.0.1", "localhost")}/real" width="700" height="400"></iframe>${other("/contact", "Contact us", NAME("contact") + `<label>Message <textarea name="contact_msg"></textarea></label>`, "Send message")}`,
  password: app("password", F3 + `<label>Password <input type="password" name="pw"></label>` + SUB),
  newsOnly: `<button type="button" data-k="OUT:apply">Apply</button>${other("/newsletter", "", `<label>Your email <input type="email" name="newsletter_email"></label>`, "Subscribe")}` });
test("3: only the application form is filled and submitted; a contact, demo, community, search, sign-in or refer form never gets the person's data", o, async () => {
  P["/real"] = doc("real", app("real", F + SUB));
  for (const id of BESIDE) {
    const x = await h.run("/" + id);
    assert.equal(x.r.status, "submitted_page_confirmed", `${id} ${JSON.stringify(x.r)}`);
    assert.deepEqual(x.posts.map((p) => p.path), [`/${id}/submit`], id); assert.deepEqual(x.typed, ["first_name", "last_name", "email", "resume"], `${id}: typed only into the application`);
  }
  for (const id of ALONE) {
    const x = await h.run("/" + id);
    assert.deepEqual(x.posts.map((p) => p.path).filter((p) => p !== "/real/submit"), [], `${id}: nothing posted to the other form`);
    assert.deepEqual(x.typed.filter((n) => !["first_name", "last_name", "email", "resume"].includes(n)), [], `${id}: nothing typed into the other form`);
    assert.ok(x.clicks.every((c) => ["OUT:apply", "Submit application"].includes(c)), `${id}: ${x.clicks}`);
  }
  assert.deepEqual((await h.run("/frame")).posts, [], "the parent's Contact us form beside the framed application is never filled or sent");
});

// ---- 4. honeypots
const TRAPS = pages({
  off: app("off", F + `<div style="position:absolute;left:-9999px"><label>Website <input name="hp_offscreen" tabindex="-1" autocomplete="off"></label></div>` + SUB),
  clear: app("clear", F + `<div style="opacity:0;height:0;overflow:hidden"><label>Company <input name="hp_opacity" tabindex="-1"></label></div>` + SUB),
  aria: app("aria", F + `<label style="position:absolute;left:-9999px" aria-hidden="true">Website <input name="hp_aria" tabindex="-1"></label>` + SUB),
  zero: app("zero", F + `<label>Company <input name="hp_zero" style="width:0;height:0;border:0;padding:0"></label>` + SUB),
  seen: app("seen", F + `<label>Website <input name="website"></label>` + SUB) });
test("4: a box a person cannot see stays empty; the same question shown to a person is answered", o, async () => {
  for (const id of TRAPS) {
    const x = await h.run("/" + id);
    assert.equal(x.r.status, "submitted_page_confirmed", `${id} ${JSON.stringify(x.r)}`);
    for (const [k, v] of Object.entries(x.posts[0].fields)) if (k.startsWith("hp_")) assert.equal(v, "", `${id}: ${k} was filled`);
  }
  assert.equal((await h.run("/seen")).posts[0].fields.website, "https://casey.example.invalid");
});

// ---- 8. human checks
const step = (s1) => `<form action="/x/submit" method="post" enctype="multipart/form-data"><div id="s1">${s1}</div><div id="s2" style="display:none"><label>Website <input name="website"></label></div>
<button type="button" id="cont" onclick="s1.style.display='none';s2.style.display='';this.style.display='none';sub.style.display=''">Continue</button><button id="sub" type="submit" style="display:none">Submit application</button></form>`;
const CHECKS = pages({
  v2badge: app("v2badge", F + CHECK + SUB) + `<div class="grecaptcha-badge" style="position:fixed;bottom:0;right:0;width:70px;height:60px">v3</div>`,
  hcStep: step(F + `<div class="h-captcha" style="width:304px;height:78px">hc box<textarea name="h-captcha-response" style="display:none"></textarea></div>`),
  friendly: app("friendly", F + `<div class="frc-captcha" data-sitekey="x" style="width:304px;height:78px;border:1px solid">Click to start verification</div>` + SUB),
  arkose: app("arkose", F + `<div id="arkose"><iframe src="/fc/gc/?k=x" data-e2e="enforcement-frame" title="Verification challenge" width="304" height="290"></iframe></div>` + SUB),
  image: app("image", F + `<img alt="captcha" width="200" height="60"><label>Enter the characters shown in the image <input name="captcha_code" required></label>` + SUB),
  late: app("late", F + `<div id="ts"></div>` + SUB) + `<script>setTimeout(function(){var d=document.createElement('div');d.className='cf-turnstile';d.style.cssText='width:300px;height:65px';d.attachShadow({mode:'closed'}).innerHTML='<iframe width=300 height=65></iframe>';ts.appendChild(d)},1500)</script>`,
  geetest: app("geetest", F + `<div class="geetest_holder" style="width:300px;height:44px">Click to verify</div>` + SUB) });
test("8: every provider's shown check, a late one and a challenge asked as a question stop the run as the check's hand-off; none is touched", o, async () => {
  P["/fc/gc/"] = `<!doctype html><body>Pick the image</body>`;
  for (const id of CHECKS) {
    const x = await h.run("/" + id, { settle: 2000 });
    assert.deepEqual([x.r.status, x.r.reason], ["needs_user", "bot_check"], `${id} ${JSON.stringify(x.r)}`);
    assert.deepEqual(x.posts, [], id); assert.ok(!x.clicks.some((c) => /submit|cont/i.test(c)), `${id}: ${x.clicks}`);
    assert.ok(!(x.r.needs || []).some((n) => /characters|captcha/i.test(n.label)), `${id}: the challenge is not a question for the person`);
    assert.ok(!x.typed.includes("captcha_code"), id);
  }
  // An invisible reCAPTCHA with only its badge is still not a shown check.
  pages({ invisible: app("invisible", F + `<div class="g-recaptcha" data-size="invisible"></div>` + SUB) + `<div class="grecaptcha-badge" style="position:fixed;bottom:10px;right:10px;width:70px;height:60px">protected by reCAPTCHA</div>` });
  assert.equal((await h.run("/invisible")).r.status, "submitted_page_confirmed");
});
