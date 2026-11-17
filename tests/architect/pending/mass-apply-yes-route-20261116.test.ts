// MASS APPLY CONVERSATIONS (2026-11-16): the reply to a card's yes says what will actually happen to each approved application,
// by the route it takes (the person's cloud setting), not "from your computer or, if you turned it on, the cloud". Unreadable:
// said as before, never guessed.
import assertNode from "node:assert/strict";
import { answerText } from "../../../supabase/functions/_shared/career_apply_cards.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const res = [{ n: 1, company: "Lumen", result: "queued" }, { n: 2, company: "Kite", result: "left_out" }] as any;
Deno.test("cloud on: the cloud sends it; cloud off: their computer; unknown: as before", () => {
  const cloud = answerText(res, { route: "cloud" }), pc = answerText(res, { route: "computer" }), none = answerText(res, {});
  assert(/1\. Lumen: approved; Trainee's cloud sends it next/.test(cloud) && !/if you turned it on/.test(cloud), cloud);
  assert(/1\. Lumen: approved; it is sent from your computer .*the cloud is off for you/.test(pc), pc);
  assert(/if you turned it on, the cloud/.test(none), none);
  assert(/2\. Kite: not sent/.test(cloud), cloud);
});
