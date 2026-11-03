// #226 review: an expired OAuth state links nothing even when correctly signed; the send rail refuses an opted-out or
// bounced recipient, whoever calls it, and records nothing as going. Microsoft is faked; nothing is sent.
import nodeAssert from "node:assert/strict";
import { issueState, sendOutlook, verifyState } from "../../supabase/functions/_shared/outlook_graph.ts";
import { sendWords } from "../../supabase/functions/_shared/outlook_connector.ts";

const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const LINK = "11111111-2222-4333-8444-555555555555", SECRET = "test-secret-not-real";

Deno.test("OUTLOOK/1 a signed state links only until it expires", async () => {
  const t0 = Date.parse("2026-10-28T12:00:00Z");
  const st = await issueState(LINK, SECRET, t0);
  eq(await verifyState(st, SECRET, t0 + 60_000), LINK, "fresh: the link");
  eq(await verifyState(st, SECRET, t0 + 16 * 60_000), null, "expired, though correctly signed: nothing");
  eq(await verifyState(st, "another-secret", t0 + 60_000), null, "signed by another secret: nothing");
});

Deno.test("OUTLOOK/2 an opted-out or bounced recipient: Microsoft is never called, the person reads why in plain words", async () => {
  for (const [ledgerSays, want, words] of [["opted_out", "OPTED_OUT", /asked not to be contacted, so it wasn't sent/], ["bounced", "BOUNCED", /bounced before, so it wasn't sent/]] as const) {
    const calls: string[] = [];
    const r = await sendOutlook({
      fetch: (async (u: string) => { calls.push(String(u)); return new Response("", { status: 202 }); }) as unknown as typeof fetch,
      token: async () => ({ status: "ok", token: "fake" }),
      ledger: { begin: async () => ledgerSays, finish: async () => { calls.push("finish"); } },
    }, "u-1", { to: "lee@globex.example", subject: "Hi", text: "Hello." }, { idemKey: "outreach:k1", purpose: "outreach" });
    eq(r.status, want);
    eq(calls, [], "no Graph call and nothing recorded as going");
    nodeAssert.match(sendWords(r), words);
  }
});
