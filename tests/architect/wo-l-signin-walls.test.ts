// WO-L (a): an employer's sign-in wall is a hand-off, never a dead end and never a credential.
// The real engine (workers/career-browser/parallel-apply.cjs) in real headless Chromium, and the real apply-VM worker
// (apply-vm.cjs) with a fake database, against local fictional employer pages (tests/architect/fixtures/wo-l-walls-driver.cjs).
// Nothing leaves 127.0.0.1. Asserted:
//  - an SSO redirect (an identity provider, or a sign-in path on another host), on load or behind "Apply", is
//    needs_user/login_required, wall sso_redirect; a redirect to an ordinary other host is still redirect_not_allowed, and
//    LinkedIn's sign-in is never handed over as one;
//  - a password form or a create-account form that appears after Apply is needs_user/login_required; an emailed-code page
//    is needs_user/email_code; the reason words are the shared HANDOFF_REASONS;
//  - the apply VM records each wall with evidence.nothing_sent = true, the wall kind and a hand-back line, never a value;
//  - no field on a wall page is ever typed into (so never a credential), and nothing is posted anywhere on a wall;
//  - control: a form behind "Apply for this job" is still filled and submitted.
import { assert, assertEquals } from "jsr:@std/assert@1";

function root(): string {
  let d = new URL(".", import.meta.url).pathname;
  for (let i = 0; i < 6; i++) {
    try { Deno.statSync(`${d}/AGENTS.md`); return d.replace(/\/$/, ""); } catch { d = `${d}/..`; }
  }
  throw Error("repo root not found");
}
const ROOT = root();
const CI = Deno.env.get("CI") === "true";
function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try {
    Deno.statSync(`${ROOT}/tools/node_modules/playwright`);
    Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`);
    return true;
  } catch {
    try {
      new Deno.Command("node", { args: ["-e", "require('playwright')"] }).outputSync().success || (() => { throw 0; })();
      return true;
    } catch { return false; }
  }
}

Deno.test({
  name: "WO-L a: SSO redirects, password and create-account walls after Apply, and emailed codes are handed back unsent, never typed into",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!browserEnv()) {
      if (CI) throw Error("WO-L a needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright");
      return;
    }
    if (Deno.uid?.() === 0 && !CI && Deno.env.get("UPMORE_CHROMIUM_SANDBOX") !== "off") {
      console.log("NOT_RUN locally as root: run it as an unprivileged user, or set UPMORE_CHROMIUM_SANDBOX=off");
      return;
    }
    const r = await new Deno.Command("node", { args: [`${ROOT}/tests/architect/fixtures/wo-l-walls-driver.cjs`, ROOT], stdout: "piped", stderr: "piped" }).output();
    const text = new TextDecoder().decode(r.stdout).trim().split("\n").pop() || "{}";
    const out = JSON.parse(text);
    assert(r.success && !out.error, `driver failed: ${out.error ?? new TextDecoder().decode(r.stderr).slice(-2000)}`);

    assertEquals(out.handoff_reasons, ["login_required", "bot_check", "email_code"]);
    const e = out.engine;
    // SSO
    assertEquals(e["sso-google"], { status: "needs_user", reason: "login_required", wall: "sso_redirect" });
    assertEquals(e["sso-path"], { status: "needs_user", reason: "login_required", wall: "sso_redirect" });
    assertEquals(e["sso-okta-apply"], { status: "needs_user", reason: "login_required", wall: "sso_redirect" }, "an SSO behind the Apply control");
    assertEquals(e["not-sso"], { status: "not_submitted", reason: "redirect_not_allowed", wall: null }, "an ordinary other host is still refused, not a sign-in");
    assertEquals(e["linkedin-sso"], { status: "not_submitted", reason: "redirect_not_allowed", wall: null }, "LinkedIn is never handed over as a sign-in");
    // walls after Apply, and an emailed code
    assertEquals(e["pw-after-apply"], { status: "needs_user", reason: "login_required", wall: "password" });
    assertEquals(e["create-after-apply"], { status: "needs_user", reason: "login_required", wall: "create_account" });
    assertEquals(e["code-on-load"], { status: "needs_user", reason: "email_code", wall: "email_code" });
    // control
    assertEquals(e["form-after-apply"].status, "submitted_page_confirmed", "a form behind 'Apply for this job' is still filled and sent");

    // The apply VM: one honest record per wall, nothing sent, no value kept.
    const expect: Record<string, [string, string]> = {
      "sso-google": ["login_required", "sso_redirect"], "pw-after-apply": ["login_required", "password"],
      "create-after-apply": ["login_required", "create_account"], "code-on-load": ["email_code", "email_code"],
    };
    for (const [job, [reason, wall]] of Object.entries(expect)) {
      const done = out.vm[job];
      assertEquals(done.length, 1, `${job}: one finish`);
      assertEquals([done[0].state, done[0].reason], ["needs_user", reason], job);
      assertEquals(done[0].evidence.nothing_sent, true, `${job}: nothing_sent`);
      assertEquals(done[0].evidence.wall, wall, job);
      assert(typeof done[0].evidence.handed_back === "string" && /finish/.test(done[0].evidence.handed_back), job);
      const ev = JSON.stringify(done[0].evidence);
      assert(!ev.includes("wo-l.person@example.invalid") && !/password"\s*:/i.test(ev), `${job}: no value in the evidence`);
    }
    assertEquals(out.vm["form-after-apply"].map((d: { state: string }) => d.state), ["submitted_unconfirmed"]);

    // No credential field, and no field at all, was typed into on a wall page; nothing was posted on a wall.
    const hits = out.hits as { method: string; path: string; query: string }[];
    const walls = ["sso-google", "sso-path", "sso-okta-apply", "pw-after-apply", "create-after-apply", "code-on-load"];
    assertEquals(hits.filter((h) => h.path === "/typed").map((h) => h.query).filter((q) => !/n=(first_name|last_name|email|resume)$/.test(q)), [],
      "only the application form's own fields were ever filled");
    assertEquals(hits.filter((h) => h.method === "POST" && walls.some((w) => h.path.includes(w))), []);
    assertEquals(hits.filter((h) => ["/signin", "/create", "/code"].includes(h.path)), [], "no sign-in, account or code form was ever sent");
    // and every POST that did happen is the control's application, once from the engine and once from the VM
    assertEquals(hits.filter((h) => h.method === "POST").map((h) => h.path), ["/greenhouse/form-after-apply/submit", "/greenhouse/form-after-apply/submit"]);
  },
});
