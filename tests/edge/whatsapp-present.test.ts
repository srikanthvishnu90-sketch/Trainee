// Presentation fixtures for the WhatsApp (Twilio sandbox) bridge: native
// markup rendering, media sends, and numbered-choice approval resolution
// into the SAME structured, hash-bound approval the app client sends.
import { handleWhatsappWebhook } from "../../supabase/functions/_shared/whatsapp_twilio.ts";
import {
  FakeAdminApprovals, assert, assertEq, envOf, fakeFetchRich, TEST_USER, SUPABASE_URL, SERVICE_KEY,
} from "./lib/channel_fixture.ts";

const AUTH = "fixture-twilio-auth-token";
const SID = "ACfixture";
const FROM_NUM = "whatsapp:+14155238886";
const USER_NUM = "+12246029341";
const HOOK_URL = "https://fixture.supabase.co/functions/v1/whatsapp-inbound";
const RUN_ID = "batch-fixture42";
const HASH = "a".repeat(64);

const CARD_REPLY = "**Your batch is ready**\n\n13 roles are tailored — see [the summary](https://example.com/s) — nothing submits until your yes.";
const APPROVED_REPLY = "Your yes is recorded for this batch exactly as carded.";

async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function deps(chat: (body: any) => any, seedRun = true) {
  const admin = new FakeAdminApprovals();
  if (seedRun) {
    admin.batchRuns.set(RUN_ID, {
      version: "career_batch_run/v1", userId: TEST_USER, runId: RUN_ID, status: "awaiting_approval",
      run: { id: RUN_ID, status: "awaiting_approval", cardSha256: HASH, summary: {} },
    });
  }
  const f = fakeFetchRich({ chat });
  const env = envOf({
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: AUTH, TWILIO_WHATSAPP_FROM: FROM_NUM,
    CHANNEL_TEST_USER_ID: TEST_USER,
    WHATSAPP_ALLOWED_NUMBERS: USER_NUM,
  });
  return { admin, calls: f.calls, d: { env, fetchFn: f.fn, createAdmin: () => admin, paceMs: 0 } as any };
}

let sidSeq = 2000;
async function waReq(body: string, from = `whatsapp:${USER_NUM}`) {
  const params = { From: from, To: FROM_NUM, Body: body, MessageSid: `SM${sidSeq++}`, NumMedia: "0", ProfileName: "Test" };
  return new Request(HOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": await twilioSignature(AUTH, HOOK_URL, params) },
    body: new URLSearchParams(params).toString(),
  });
}
const agentCalls = (calls: any[]) => calls.filter((c) => c.url.includes("/functions/v1/agent-chat"));
const sendForms = (calls: any[]) => calls.filter((c) => c.url.includes("api.twilio.com")).map((c) => new URLSearchParams(c.init.body));

function cardThenApprove(body: any) {
  if (body.career_batch?.action === "approve") return { reply: APPROVED_REPLY };
  return {
    reply: CARD_REPLY,
    batch: { version: "career_batch_run/v1", id: RUN_ID, userId: TEST_USER, status: "awaiting_approval", kind: "batch_run", summary: {} },
  };
}

Deno.test("card reply renders in whatsapp markup and offers numbered choices", async () => {
  const { d, calls, admin } = deps(cardThenApprove);
  const res = await handleWhatsappWebhook(await waReq("batch status"), d);
  assertEq(res.status, 200);
  const forms = sendForms(calls);
  const cardText = forms.map((f) => f.get("Body") ?? "").join("\n");
  assert(cardText.includes("*Your batch is ready*"), "bold renders as *bold*: " + cardText);
  assert(cardText.includes("the summary (https://example.com/s)"), "link renders label + bare tappable url");
  assert(!cardText.includes("**"), "no foreign markup left behind");
  assert(cardText.includes("Reply with a number:"), "numbered choices offered");
  assert(cardText.includes("1 — Approve this batch"), "choice 1 is the approval");
  assert(cardText.includes("2 — Not now"), "choice 2 declines");
  assertEq(admin.approvals.size, 1, "one pending approval stored");
  assertEq([...admin.approvals.values()][0].card_sha256, HASH, "hash bound server-side");
});

Deno.test("replying 1 resolves to the identical structured approval as the app client", async () => {
  const { d, calls } = deps(cardThenApprove);
  await handleWhatsappWebhook(await waReq("batch status"), d);
  const res = await handleWhatsappWebhook(await waReq("1"), d);
  assertEq(res.status, 200);
  const ac = agentCalls(calls);
  assertEq(ac.length, 2, "card turn + approval turn");
  const approveBody = JSON.parse(ac[1].init.body);
  assertEq(approveBody.message, `Approve batch ${RUN_ID}`, "the exact approval message");
  assertEq(approveBody.career_batch.action, "approve");
  assertEq(approveBody.career_batch.cardSha256, HASH);
  assertEq(approveBody.career_batch.runId, RUN_ID);
  assert(sendForms(calls).some((f) => (f.get("Body") ?? "").includes("Your yes is recorded")), "the core's answer is what the user sees");
  // The spent choice never approves twice: another "1" is just a message now.
  await handleWhatsappWebhook(await waReq("1"), d);
  const ac2 = agentCalls(calls);
  assertEq(JSON.parse(ac2[ac2.length - 1].init.body).career_batch, undefined, "no second structured approval");
});

Deno.test("replying 2 declines in product voice and approves nothing", async () => {
  const { d, calls } = deps(cardThenApprove);
  await handleWhatsappWebhook(await waReq("batch status"), d);
  await handleWhatsappWebhook(await waReq("2"), d);
  assertEq(agentCalls(calls).length, 1, "no approval call was made");
  assert(sendForms(calls).some((f) => (f.get("Body") ?? "").includes("nothing was approved")), "dismissal spoken plainly");
});

Deno.test("a bare 1 with no pending card is an ordinary message, untouched", async () => {
  const { d, calls } = deps(() => ({ reply: "One what?" }), false);
  await handleWhatsappWebhook(await waReq("1"), d);
  const ac = agentCalls(calls);
  assertEq(ac.length, 1);
  const body = JSON.parse(ac[0].init.body);
  assertEq(body.message, "1");
  assertEq(body.career_batch, undefined, "no structured request is fabricated");
});

Deno.test("long structured replies split without cutting links or list items", async () => {
  const items = Array.from({ length: 80 }, (_, i) => `- Role ${i} — https://jobs.example.com/posting/${i}?utm_source=trainee&ref=chat`);
  const { d, calls } = deps(() => ({ reply: ["**Roles**", "", ...items].join("\n") }), false);
  await handleWhatsappWebhook(await waReq("list them"), d);
  const forms = sendForms(calls);
  assert(forms.length >= 2, "split into multiple messages");
  for (const f of forms) {
    const body = f.get("Body") ?? "";
    assert(body.length <= 4096, "within the whatsapp limit");
    for (const m of body.matchAll(/https:\/\/\S+/g)) {
      assert(/^https:\/\/jobs\.example\.com\/posting\/\d+\?utm_source=trainee&ref=chat$/.test(m[0]), "complete url only: " + m[0]);
    }
  }
});

Deno.test("document artifacts are sent as media; the current contract sends none", async () => {
  {
    const { d, calls } = deps(() => ({
      reply: "Here is your tailored resume.",
      artifacts: [{ kind: "document", url: "https://files.example.com/resume.pdf", filename: "resume.pdf" }],
    }), false);
    await handleWhatsappWebhook(await waReq("send my resume"), d);
    const withMedia = sendForms(calls).filter((f) => f.get("MediaUrl"));
    assertEq(withMedia.length, 1, "one media send");
    assertEq(withMedia[0].get("MediaUrl"), "https://files.example.com/resume.pdf");
  }
  {
    const { d, calls } = deps(() => ({ reply: "No file this time." }), false);
    await handleWhatsappWebhook(await waReq("hi"), d);
    assertEq(sendForms(calls).filter((f) => f.get("MediaUrl")).length, 0, "no artifact field -> no media (CHANNEL-DOC-1)");
  }
});

Deno.test("an agent failure is spoken in product voice, once", async () => {
  const { d, calls } = deps(() => ({ __status: 500, body: { error: "internal" } }), false);
  const res = await handleWhatsappWebhook(await waReq("find roles"), d);
  assertEq(res.status, 500);
  const errs = sendForms(calls).filter((f) => (f.get("Body") ?? "").includes("the request failed on Trainee's side"));
  assertEq(errs.length, 1, "one plain error with a next step");
});
