// D-MN-2 on #225's review: with D-MN-1 an approval now sends from the person's Gmail, so a question ("send them all?",
// "send 3?", "approve them?") approves nothing. NO LIMITS: who was already contacted is read in full (a silent cut at
// 5,000 would let someone be emailed twice). Synthetic only; nothing is sent.
import assertNode from "node:assert/strict";
import { memoryOutreachStore, messageOf, OPT_OUT_LINE, OUTREACH_INTENT, outreachTurn, payloadHash, supabaseOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "TEST-Q", TH = "TEST-Q-THREAD", T0 = Date.parse("2026-10-28T15:00:00Z");

async function shown(store: ReturnType<typeof memoryOutreachStore>) {
  const ds: any[] = [];
  for (let n = 1; n <= 5; n++) {
    const d: any = { n, recipient: { name: `Person ${n} Synthetic`, firm: "Firm", title: "Analyst", school: "", email: `q${n}@firm.example`, source: `list.csv, row ${n}` },
      subject: `Question ${n}`, body: `Hi ${n}.`, footer: `Sam\n\n${OPT_OUT_LINE}`, status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null,
      created_at: new Date(T0).toISOString(), hash: "", shared: [] };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  await store.saveBatch(U, TH, ds, T0);
  store.setIntent(TH, OUTREACH_INTENT);
}

Deno.test("Q/1 a question never approves a batch of emails", async () => {
  for (const m of ["send them all?", "send all?", "send 3?", "approve them?", "Send all of them?", "yes?", "send 1 and 2?"]) {
    const store = memoryOutreachStore();
    await shown(store);
    const handed: unknown[] = [];
    const r = await outreachTurn({ message: m, userId: U, threadId: TH, now: T0 + 1000, store, gmailConnected: async () => true, onApproved: async (_u, items) => { handed.push(...items); } });
    eq(r?.status === "approved", false, `${m}: ${r?.reply}`);
    eq(handed, [], `${m}: nothing handed to the send rail`);
    eq((await store.latestBatch(U)).filter((d) => d.status === "approved").length, 0, `${m}: nothing approved`);
  }
  // The plain answer still approves.
  const store = memoryOutreachStore();
  await shown(store);
  eq((await outreachTurn({ message: "send all", userId: U, threadId: TH, now: T0 + 1000, store, gmailConnected: async () => true }))?.status, "approved");
});

Deno.test("Q/2 everyone already contacted is read, in pages, never cut at 5,000", async () => {
  const all = Array.from({ length: 12_345 }, (_, i) => ({ recipient_email: `P${i}@x.example` }));
  const q: any = { select: () => q, eq: () => q, neq: () => q, order: () => q, limit: () => { throw new Error("must page"); },
    range: (a: number, b: number) => Promise.resolve({ data: all.slice(a, Math.min(b + 1, a + 1000)), error: null }) };
  const store = supabaseOutreachStore({ from: () => q } as any);
  const got = await store.contacted("u");
  eq(got.size, 12_345);
  eq(got.has("p12344@x.example"), true);
});
