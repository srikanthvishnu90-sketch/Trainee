// D-072 (item 4, round 2): the hand-off's live wiring, end to end, at $0, with no test-only seam in the product path.
//   database  every migration (20261112160000: handoff_done_at / handoff_yes on the apply rows, career_apply_handoff_done_as /
//             _yes_as / career_apply_vm_handoff_state) and the card-cloud bridge's stored approvals, on the flow harness's Postgres
//   chat      the production handler (agent-chat handler-career.ts handleChat, real supabase-js over the PostgREST double)
//   worker    the real apply VM (apply-vm.cjs createWorker + parallel-apply.cjs) in real headless Chromium, through its own
//             database role (tests/architect/fixtures/handoff-recheck-driver.cjs)
//   person    their OWN browser (a separate Chromium context) doing the one step at the link the hand-off gave them
// Two fictional employers on 127.0.0.1:
//   A  an emailed-code wall the employer clears for THIS application on its own side once the person enters the code: the cloud
//      re-check, in a new session with none of the person's cookies, finds the form; the exact-answers card is shown; a yes to
//      that card's hash submits exactly once. Before the yes, nothing is posted; "yes" to anything else posts nothing.
//   B  a sign-in wall the employer keeps in the person's own browser session (a cookie): the person signs in in THEIR browser; the
//      cloud re-check still meets the wall (it never carries their cookies), so the row is needs_extension, the hand-off stop,
//      never a pass and never sent.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try { Deno.statSync(`${ROOT}/tools/node_modules/playwright`); Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`); return true; } catch { return false; }
}
const RESUME_HEX = Array.from(new TextEncoder().encode("%PDF-1.4\n% TEST resume for the hand-off\n")).map((b) => b.toString(16).padStart(2, "0")).join("");

// The fictional employers. A's code is cleared on the employer's side per application; B's sign-in lives in a browser cookie.
function employers() {
  const posts: Record<string, number> = { A: 0, B: 0 };
  let codeCleared = false;
  const page = (t: string, b: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body><p>FICTIONAL EMPLOYER (test fixture)</p>${b}</body></html>`;
  const form = (job: string) => page("Application", `<h1>Analyst</h1><form method="post" action="/greenhouse/${job}/submit" enctype="multipart/form-data">
<label for="first_name">First Name *</label><input id="first_name" name="first_name" type="text" required>
<label for="last_name">Last Name *</label><input id="last_name" name="last_name" type="text" required>
<label for="email">Email *</label><input id="email" name="email" type="email" required>
<label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required>
<button type="submit">Submit Application</button></form>`);
  const code = page("Check your email", `<h1>Check your email</h1><p>We sent a 6-digit code to your email. Enter the code to continue.</p><form method="post" action="/greenhouse/A/code"><label for="c">Code</label><input id="c" name="code" type="text" autocomplete="one-time-code"><button type="submit">Verify</button></form>`);
  const signin = page("Sign in", `<h1>Sign in to apply</h1><form method="post" action="/greenhouse/B/signin"><label for="u">Email</label><input id="u" name="username" type="email"><label for="p">Password</label><input id="p" name="password" type="password"><button type="submit">Sign in</button></form>`);
  const html = (b: string, extra: Record<string, string> = {}) => new Response(b, { headers: { "content-type": "text/html; charset=utf-8", ...extra } });
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    if (req.method === "POST") {
      await req.arrayBuffer().catch(() => null);
      if (u.pathname === "/greenhouse/A/code") { codeCleared = true; return html(form("A")); }
      if (u.pathname === "/greenhouse/B/signin") return html(page("Signed in", "<h1>Signed in</h1>"), { "set-cookie": "employer_session=person; Path=/; HttpOnly" });
      const m = /^\/greenhouse\/([AB])\/submit$/.exec(u.pathname);
      if (m) { posts[m[1]]++; return html(page("Thanks", `<h1>Thank you for applying.</h1><p id="confirmation">Your application has been submitted. GH-TEST-${m[1]}</p>`)); }
      return new Response("no", { status: 404 });
    }
    if (u.pathname === "/greenhouse/A/1") return html(codeCleared ? form("A") : code);
    if (u.pathname === "/greenhouse/B/2") return html(/employer_session=person/.test(req.headers.get("cookie") ?? "") ? form("B") : signin);
    return new Response("not found", { status: 404 });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { a: `${base}/greenhouse/A/1`, b: `${base}/greenhouse/B/2`, posts, close: () => server.shutdown() };
}

async function node(args: string[]) {
  const r = await new Deno.Command("node", { args: [`${ROOT}/tests/architect/fixtures/handoff-recheck-driver.cjs`, ROOT, ...args], stdout: "piped", stderr: "piped" }).output();
  const line = new TextDecoder().decode(r.stdout).trim().split("\n").pop() || "{}";
  const out = JSON.parse(line);
  if (!r.success || out.error) throw Error(`driver ${args[0]}: ${out.error ?? new TextDecoder().decode(r.stderr).slice(-1500)}`);
  return out;
}

Deno.test({
  name: "D-072 hand-off live: wall -> one link -> the person's step in their own browser -> 'done' -> cloud re-check in a new session -> exact-answers card -> yes to that card's hash -> Submit once; a session-bound wall is needs_extension, never sent",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the hand-off flow needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI && Deno.env.get("UPMORE_CHROMIUM_SANDBOX") !== "off") { console.log("NOT_RUN locally as root: run it as an unprivileged user, or set UPMORE_CHROMIUM_SANDBOX=off"); return; }
    const pg = await startPg({ includeBridge: true });
    const site = employers();
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      const A = "00000000-0000-4000-8000-0000000d0721", B = "00000000-0000-4000-8000-0000000d0722";
      for (const [k, v] of [["APPLY_VM", "on"], ["APPLY_VM_USER_IDS", "*"], ["APPLY_VM_ALLOW_LOCAL", "on"]]) {
        await pg.sql(`insert into career_cloud_settings(key,value) values ('${k}','${v}') on conflict (key) do update set value=excluded.value`);
      }
      const sha = (await pg.sql(`select encode(sha256(decode('${RESUME_HEX}','hex')),'hex')`)).trim();
      for (const u of [A, B]) {
        await pg.sql(`insert into auth.users(id,email) values ('${u}','${u}@example.test') on conflict do nothing;
          insert into profiles(id) values ('${u}') on conflict do nothing;
          insert into career_watch_kv(user_id,key,value) values ('${u}','career:account','{"epoch":1,"version":1,"paused":false}') on conflict do nothing;
          insert into career_apply_cloud_optin(user_id,enabled,terms,terms_sha256,privacy_epoch,turned_on_at) values ('${u}',true,'test terms',repeat('a',64),1,now()) on conflict do nothing;
          insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch) values ('${u}','${sha}','resume.pdf',decode('${RESUME_HEX}','hex'),1) on conflict do nothing;
          insert into career_message_approval_private.test_users(user_id) values ('${u}') on conflict do nothing;
          select public.career_resume_put('${u}'::uuid,'${sha}','file','test:handoff','resume.pdf',decode('${RESUME_HEX}','hex'),'seed:handoff');`);
      }
      // One approved application each, with a real stored approval for exactly its payload (as a tapped card leaves it).
      const fields = `'[{"label":"First Name","value":"Test","factId":"f1"},{"label":"Last Name","value":"Person","factId":"f2"},{"label":"Email","value":"test.person@example.invalid","factId":"f3"}]'::jsonb`;
      const rows = `select x.u, x.jid, x.co, x.url, jsonb_build_object('version',1,'user_id',x.u,'job_id',x.jid,'company',x.co,'url',x.url,'fields',${fields},'privacy_epoch',1,'account_version',1,'expires_at','2099-01-01T00:00:00Z'::text,'engine_approval',repeat('e',64),'resume_sha256','${sha}','destination',x.url) as p
        from (values ('${A}','HANDOFF-A','TEST Code Employer','${site.a}'), ('${B}','HANDOFF-B','TEST Session Employer','${site.b}')) as x(u,jid,co,url)`;
      await pg.sql(`with s as (${rows}), a as (insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,approved_at,used_at)
          select s.u::uuid, s.jid, public.career_apply_payload_hash(s.p), s.p, now(), now() from s returning id, user_id, job_id, batch_hash)
        insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at)
          select a.id, a.user_id, gen_random_uuid(), 0, a.batch_hash, now(), now() + interval '23 hours' from a;
        with s as (${rows}) insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
          select s.u::uuid, s.jid, s.co, s.url, s.p, public.career_apply_payload_hash(s.p), public.career_apply_payload_hash(s.p) from s;`);
      const row = async (u: string) => JSON.parse(await pg.sql(`select row_to_json(j) from (select id, state, reason, handoff_done_at, handoff_yes, evidence from career_apply_jobs where user_id='${u}') j`));
      agentChat = await careerHandler(pg, { "tok-a": A, "tok-b": B });
      const chatA = agentChat.chat("tok-a"), chatB = agentChat.chat("tok-b");
      const drain = () => node(["drain", pg.host, String(pg.port)]);

      await t.step("the first run stops at each wall, nothing sent, with one link to the employer's own page", async () => {
        await drain();
        const a = await row(A), b = await row(B);
        assertEquals([a.state, a.reason], ["needs_user", "email_code"]);
        assertEquals([b.state, b.reason], ["needs_user", "login_required"]);
        for (const r of [a, b]) { assertEquals(r.evidence.nothing_sent, true); assert(r.evidence.handoff?.link, "one link"); assertEquals(r.handoff_done_at, null); }
        assertEquals(a.evidence.handoff.link, site.a);
        assertEquals(site.posts, { A: 0, B: 0 });
      });

      await t.step("A: a yes before any card approves nothing; the person enters the code in their own browser and says done; the re-check is queued", async () => {
        const early = await chatA.say("yes");
        assertEquals(early.status, 200);
        assert(early.intent !== "career_apply_handoff_yes", "no hand-off card was shown: a yes is not the hand-off's");
        const person = await node(["person-code", site.a]);
        assertEquals(person.cookies, [], "the employer cleared the code on its own side; nothing of the person's travels");
        const done = await chatA.say("done");
        assertEquals(done.status, 200, done.reply);
        assertEquals(done.intent, "career_apply_handoff", done.reply);
        const a = await row(A);
        assertEquals(a.state, "queued");
        assert(a.handoff_done_at, "handoff_done_at set");
        assertEquals(a.handoff_yes, null);
      });

      await t.step("A: the cloud re-check (new session) records the exact answers as a card, nothing sent; 'done' shows that card", async () => {
        await drain();
        const a = await row(A);
        assertEquals([a.state, a.reason], ["needs_user", "ready_for_yes"]);
        assertEquals(a.evidence.nothing_sent, true);
        const card = a.evidence.answers_card;
        assert(/^[0-9a-f]{64}$/.test(card.hash), "card hash");
        const shown = card.answers.map((x: any) => `${x.field}=${x.value}`).sort();
        assertEquals(shown.filter((s: string) => !/^Resume/.test(s)), ["Email=test.person@example.invalid", "First Name=Test", "Last Name=Person"]);
        assertEquals(site.posts.A, 0, "a re-check never posts");
        const c = await chatA.say("done");
        assertEquals(c.intent, "career_apply_handoff_card", c.reply);
        assert(c.reply.includes("First Name: Test") && c.reply.includes("Email: test.person@example.invalid"), c.reply);
        assertEquals(c.body?.meta?.handoff_card?.hash, card.hash, "the card's hash rides the reply");
      });

      await t.step("A: yes to the card shown -> Submit exactly once, only while the page holds exactly that card", async () => {
        const wrong = JSON.parse(await pg.sql(`select public.career_apply_handoff_yes_as('${A}'::uuid, (select id from career_apply_jobs where user_id='${A}'), repeat('0',64))::text`));
        assertEquals(wrong, { ok: false, why: "card_changed" }, "a yes to any other card is refused");
        assertEquals((await row(A)).state, "needs_user");
        const y = await chatA.say("yes");
        assertEquals(y.intent, "career_apply_handoff_yes", y.reply);
        let a = await row(A);
        assertEquals(a.state, "queued");
        assertEquals(a.handoff_yes.card_hash, a.evidence.answers_card?.hash ?? a.handoff_yes.card_hash);
        await drain();
        a = await row(A);
        assertEquals(a.state, "submitted_unconfirmed", JSON.stringify(a.evidence).slice(0, 400));
        assertEquals(site.posts.A, 1, "exactly one Submit");
        await drain();
        assertEquals(site.posts.A, 1, "never again");
      });

      await t.step("B: the person signs in in their own browser; the cloud re-check does not carry their cookie -> needs_extension, never sent", async () => {
        const person = await node(["person-signin", site.b]);
        assert(person.cookies.includes("employer_session"), "the sign-in lives in the person's own browser");
        const done = await chatB.say("done");
        assertEquals(done.intent, "career_apply_handoff", done.reply);
        await drain();
        const b = await row(B);
        assertEquals([b.state, b.reason], ["needs_user", "login_required"]);
        assertEquals(b.evidence.needs_extension, true, "the employer keeps the step in the person's session");
        assertEquals(b.evidence.nothing_sent, true);
        assertEquals(site.posts.B, 0);
        const again = await chatB.say("done");
        assertEquals(again.resultStatus, "needs_extension", again.reply);
        assert(again.reply.includes(site.b), "the employer page link");
        const yes = await chatB.say("yes");
        assert(yes.intent !== "career_apply_handoff_yes");
        assertEquals((await row(B)).state, "needs_user");
        assertEquals(site.posts.B, 0, "never sent");
      });
    } finally {
      await agentChat?.close?.();
      await site.close();
      await pg.stop();
    }
  },
});
