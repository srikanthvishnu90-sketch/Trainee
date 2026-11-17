// ag/ma-07-yes-route (2026-11-17; source: ag/mass-apply-10 997634ed7, which said one route for the whole person). The reply to
// a card's yes says what will actually happen to EACH approved application (D-024): Trainee's cloud sends it; it goes from
// their computer (the cloud is off for them); or the cloud can't send it because <reason>, so it goes from their computer.
// What cannot be read is said as unconfirmed. Before: every approved line read "approved; it is sent next, from your
// computer or, if you turned it on, the cloud", whatever the posting's board.
// The routes are read, never decided here: the same inputs the database's cloud claim checks (career_apply_send_route.ts).
import assertNode from "node:assert/strict";
import { answerText, cardTurn, type CardStore } from "../../../supabase/functions/_shared/career_apply_cards.ts";
import { portalOf, routeOf, supabaseSendRoutes } from "../../../supabase/functions/_shared/career_apply_send_route.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

const U = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1", NOW = Date.parse("2026-11-17T15:00:00Z");
const LUMEN = "aaaaaaaa-0000-4000-8000-0000000000a1", ACME = "aaaaaaaa-0000-4000-8000-0000000000a2";
// One cloud-sendable application (a Greenhouse posting with the employer's https endpoint) and one on a board the cloud does
// not submit on (Workday).
const PREPARED = [
  { id: LUMEN, url: "https://boards.greenhouse.io/lumen/jobs/801", destination: "https://boards-api.greenhouse.io/v1/boards/lumen/jobs/801" },
  { id: ACME, url: "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Chicago/Data-Analyst_R123", destination: "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/apply" },
];
// The service client double: the person's opt-in, the prepared rows (scoped to the person and the ids asked), the gate.
function admin(o: { optIn?: boolean | "error"; gate?: Record<string, boolean>; waiver?: number; prepared?: typeof PREPARED | "error" } = {}) {
  const calls: string[] = [];
  return {
    calls,
    rpc: async (name: string, args: any) => {
      calls.push(name);
      if (name === "career_apply_cloud_optin_get") return o.optIn === "error" ? { error: { message: "down" } } : { data: { enabled: o.optIn ?? true } };
      if (name === "career_apply_cloud_open") return { data: (o.gate ?? { greenhouse: true })[args.p_portal] ?? false };
      if (name === "career_apply_cloud_waiver_left") return { data: o.waiver ?? 0 };
      throw Error(name);
    },
    from: (t: string) => ({ select: () => ({ eq: (_c: string, user: string) => ({ in: async (_k: string, ids: string[]) => {
      calls.push(t);
      if (o.prepared === "error") return { error: { message: "down" } };
      return { data: user === U ? (o.prepared ?? PREPARED).filter((p) => ids.includes(p.id)) : [] };
    } }) }) }),
  };
}

// A card of the two, open and shown a minute ago; the database queues both on the yes.
function store(): CardStore {
  return {
    pending: async () => [], open: async () => { throw Error("not opened here"); },
    latestOpen: async () => ({ id: "cccccccc-0000-4000-8000-0000000000c1", items: [{ n: 1, prepared_id: LUMEN, payload_hash: "1".repeat(64) }, { n: 2, prepared_id: ACME, payload_hash: "2".repeat(64) }], shown_at: new Date(NOW - 60_000).toISOString() }),
    answer: async (_u, _c, approve) => [{ n: 1, company: "Lumen", result: approve.includes(1) ? "queued" : "left_out" }, { n: 2, company: "Acme", result: approve.includes(2) ? "queued" : "left_out" }],
    lastAssistantIntent: async () => "career_apply_card", lastShownCard: async () => "cccccccc-0000-4000-8000-0000000000c1",
  };
}
const yes = async (a: ReturnType<typeof admin>, cloudOn: boolean | null = true, message = "yes") =>
  (await cardTurn({ message, userId: U, threadId: "t1", now: NOW, store: store(), routes: (ids) => supabaseSendRoutes(a, U, ids, { now: NOW, cloudOn: async () => cloudOn }) }))!.reply;

Deno.test("a mixed batch: the Greenhouse application goes by the cloud; the Workday one can't, and says why and how it goes", async () => {
  const reply = await yes(admin());
  assert(/^1\. Lumen: approved; Trainee's cloud sends it, on its own/m.test(reply), reply);
  assert(/^2\. Acme: approved; the cloud can't send it because Trainee's cloud does not submit on acme\.wd5\.myworkdayjobs\.com \(it submits on Greenhouse, Lever, Ashby and SmartRecruiters\), so it is sent from your computer/m.test(reply), reply);
  assert(!/if you turned it on, the cloud/.test(reply), "never the one line for everyone");
  assert(/^2 approved exactly as shown\. Nothing has gone to an employer yet\./.test(reply), reply);
});

Deno.test("the cloud off for them: each goes from their computer; the gate is never read", async () => {
  const a = admin({ optIn: false });
  const reply = await yes(a);
  assert(/^1\. Lumen: approved; it is sent from your computer .*\(the cloud is off for you\)$/m.test(reply), reply);
  assert(/^2\. Acme: approved; it is sent from your computer .*\(the cloud is off for you\)$/m.test(reply), reply);
  eq(a.calls.includes("career_apply_cloud_open"), false);
});

Deno.test("why the cloud can't: switches off, a family not open yet (a waiver with sends left opens it), a form only they can submit", async () => {
  assert(/^1\. Lumen: approved; the cloud can't send it because Trainee's cloud sending is switched off right now/m.test(await yes(admin(), false)));
  assert(/^1\. Lumen: approved; the cloud can't send it because Trainee's cloud is not open for Greenhouse applications yet/m.test(await yes(admin({ gate: {} }))));
  assert(/^1\. Lumen: approved; Trainee's cloud sends it/m.test(await yes(admin({ gate: {}, waiver: 3 }))));
  const formOnly = await yes(admin({ prepared: [{ ...PREPARED[0], destination: "" as string }, PREPARED[1]] }));
  assert(/^1\. Lumen: approved; the cloud can't send it because the employer's form there is one only you can submit/m.test(formOnly), formOnly);
});

Deno.test("unreadable: said as unconfirmed, never guessed; only what was approved gets a route", async () => {
  for (const r of [await yes(admin({ optIn: "error" })), await yes(admin(), null), await yes(admin({ prepared: "error" }))]) {
    assert(/^1\. Lumen: approved; how it is sent is unconfirmed right now/m.test(r), r);
    assert(!/Trainee's cloud sends it/.test(r), r);
  }
  const only = await yes(admin(), true, "yes except 2");
  assert(/^1\. Lumen: approved; Trainee's cloud sends it/m.test(only) && /^2\. Acme: not sent: you left it out/m.test(only), only);
  // No route reader at all (another caller): exactly as before.
  assert(/1\. Lumen: approved; it is sent next, from your computer or, if you turned it on, the cloud/.test(answerText([{ n: 1, company: "Lumen", result: "queued" }])));
});

Deno.test("the family as the database derives it (career_apply_portal), and the route's order of checks", () => {
  eq(["https://boards.greenhouse.io/x/jobs/1", "https://job-boards.greenhouse.io/x/jobs/1", "https://jobs.lever.co/x/1", "https://jobs.ashbyhq.com/x/1", "https://jobs.smartrecruiters.com/X/1",
    "http://boards.greenhouse.io/x/jobs/1", "https://evilgreenhouse.io/x", "https://acme.wd5.myworkdayjobs.com/x", "https://user@boards.greenhouse.io/x"].map(portalOf),
  ["greenhouse", "greenhouse", "lever", "ashby", "smartrecruiters", null, null, null, null]);
  const base = { optIn: true, cloudOn: true, url: PREPARED[0].url, destinationOk: true, gateOpen: true };
  eq(routeOf(base), { via: "cloud" });
  eq(routeOf({ ...base, optIn: false, cloudOn: null, gateOpen: null }), { via: "computer" });
  eq(routeOf({ ...base, gateOpen: null }), { via: "unknown" });
});
