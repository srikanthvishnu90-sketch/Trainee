"use strict";
// Round 2 (review of #818), item 6, in Chromium: a value the page rewrites after it was filled (a name upper-cased with a suffix, a
// phone reformatted without its country code) is refused before the click; a box the page's own submit handler ticks at the
// click is stopped by the in-page guard before the browser sends the form. Read from the server: nothing posted.
// Run: node --test tests/career-engine-round2-submit-guard-browser.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, st, doc, F3, SUB, skip } = require("./fixtures/engine-round2/harness.cjs");
const P = st.pages, o = { skip, timeout: 240000 };
const app = (id, inner) => `<form id="app" action="/${id}/submit" method="post">${F3}${inner}${SUB}</form>`;
P["/k28"] = doc("k28", app("k28", `<label>Phone <input name="phone"></label><script>document.querySelector('[name=phone]').addEventListener('blur',function(){var d=this.value.replace(/\\D/g,'');if(d.length===11)this.value='('+d.slice(1,4)+') '+d.slice(4,7)+'-'+d.slice(7)})</script>`));
P["/k29"] = doc("k29", app("k29", `<script>document.addEventListener('change',function(e){if(e.target.name==='last_name')setTimeout(function(){e.target.value=e.target.value.toUpperCase()+' JR'},400)})</script>`));
P["/k30"] = doc("k30", app("k30", `<label><input type="checkbox" name="mk" value="1"> Email me offers</label><script>document.getElementById('app').addEventListener('submit',function(){this.mk.checked=true})</script>`));
P["/k30b"] = doc("k30b", app("k30b", `<label>Notes <input name="notes"></label>`));
let h;
before(async () => { if (!skip) h = await start(); });
after(async () => { if (h) await h.stop(); });

test("6: a value the page rewrote after the fill is refused before the click; nothing is posted", o, async () => {
  // Round 3 (architect ruling): a phone the page only reformats (same digits, k28) is the same value and goes; a rewritten name
  // (k29) is still refused. Round 3's own tests assert k28 is sent with its digits unchanged.
  for (const id of ["k29"]) {
    const x = await h.run("/" + id);
    assert.equal(x.r.status, "not_submitted", `${id} ${JSON.stringify(x.r)}`);
    assert.deepEqual(x.posts, [], id); assert.deepEqual(x.phases, [], `${id}: refused before the submitting record`);
  }
});

test("6: a box the page's own submit handler ticks at the click: the guard stops the form before it is sent", o, async () => {
  const x = await h.run("/k30");
  assert.deepEqual([x.r.status, x.r.reason], ["not_submitted", "page_changed_at_submit"], JSON.stringify(x.r));
  assert.deepEqual(x.posts, []);
  // An unchanged page is still sent, once, with a slow submitting record (the heartbeat) before the click.
  const y = await h.run("/k30b", { beat: 1500 });
  assert.equal(y.r.status, "submitted_page_confirmed", JSON.stringify(y.r)); assert.equal(y.posts.length, 1);
});
