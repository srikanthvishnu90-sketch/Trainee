// R9-E routing (the coordinator's ask from the end-to-end eval, PR #591, outreach area 5/10 on trunk):
//   "find and email the hiring manager at X" is an outreach draft (it was taken for a job search), and the hiring manager
//   is a manager there in the person's own contacts;
//   several people in one ask ("email Sam at Cobalt and Noah at Fable", "the recruiters at Stripe and Acme") are one batch,
//   one draft and one exact-payload hash each, so "send all" approves exactly what was shown (D-MN-2);
//   a firm whose own name has "and" or "&" in it stays one firm when the person's contacts have it.
import assertNode from "node:assert/strict";
import { parseNetworkingAsk } from "../../supabase/functions/_shared/career_networking.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

Deno.test("R9-E routing: find-and-email the hiring manager, several people in one ask, and-firms kept whole", () => {
  for (const m of ["find and email the hiring manager at Cobalt", "Find & email the hiring manager at Cobalt", "look up and email the hiring manager at Cobalt"]) {
    eq(parseNetworkingAsk(m), { kind: "draft", topic: null, target: { by: "group", firm: "Cobalt", count: 1, role: "hiring manager" } }, m);
  }
  eq(parseNetworkingAsk("email Sam at Cobalt and Noah at Fable about new grad roles"),
    { kind: "draft", topic: "new grad roles", target: { by: "name", name: "Sam", firm: "Cobalt" }, more: [{ by: "name", name: "Noah", firm: "Fable" }] });
  eq(parseNetworkingAsk("email Sam at Cobalt, Noah at Fable and Maya at Stripe"),
    { kind: "draft", topic: null, target: { by: "name", name: "Sam", firm: "Cobalt" }, more: [{ by: "name", name: "Noah", firm: "Fable" }, { by: "name", name: "Maya", firm: "Stripe" }] });
  // The firm stays as typed in the ask; the draft turn splits it only when the person's contacts have no such firm
  // ("Procter & Gamble" stays one firm), and the eval's E16 proves the split end to end.
  eq(parseNetworkingAsk("email the recruiters at Stripe and Acme"), { kind: "draft", topic: null, target: { by: "group", firm: "Stripe and Acme", count: null, role: "recruiter" } });
  // Unchanged: one person, one firm; a second ask after the firm is not a second person; an and-firm without a plural role.
  eq(parseNetworkingAsk("email Maya at Stripe about the data analyst role"), { kind: "draft", topic: "the data analyst role", target: { by: "name", name: "Maya", firm: "Stripe" } });
  eq(parseNetworkingAsk("email people at Ernst and Young"), { kind: "draft", topic: null, target: { by: "group", firm: "Ernst and Young", count: null, role: null } });
  eq(parseNetworkingAsk("email Maya at Stripe and apply to Stripe")?.kind, "draft");
  eq((parseNetworkingAsk("email Maya at Stripe and apply to Stripe") as any).more, undefined);
  eq(parseNetworkingAsk("find jobs at Cobalt"), null, "a job search stays a job search");
});
