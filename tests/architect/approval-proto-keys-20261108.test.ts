// PROTOTYPE KEYS (S2 review of #614, follow-up): a word typed by the person is looked up only among a table's own keys.
// "only constructor" read "constructor" as a card position (ORDINAL_WORD["constructor"] is Object's constructor) and
// produced [null]; Constructor is an employer. The billing typo table turned "constructor" into a function's source text.
import assertNode from "node:assert/strict";
import { parseCardReply } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { billingAsk } from "../../supabase/functions/_shared/career_billing.ts";
import { db as cardDb } from "./mass-submit-fixture.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const PROTO = ["constructor", "tostring", "valueof", "hasownproperty", "__proto__", "isprototypeof", "propertyisenumerable", "tolocalestring"];

Deno.test("PROTO/1 a card position is only an ordinal word, never an Object.prototype name", () => {
  for (const p of PROTO) {
    for (const m of [`only ${p}`, `only the ${p} one`, `yes except ${p}`, `send ${p} and 2`, `only 1 and ${p}`]) {
      const r = parseCardReply(m) as any;
      const nums = r?.only ?? r?.except ?? [];
      assertNode.ok(nums.every((n: unknown) => Number.isInteger(n) && (n as number) >= 1), `${m}: positions are whole numbers: ${JSON.stringify(r)}`);
    }
  }
  eq(parseCardReply("only the second one"), { kind: "only", only: [2] });
  eq(parseCardReply("only first and third"), { kind: "only", only: [1, 3] });
});
Deno.test("PROTO/2 on a card of 3, 'only constructor' / 'yes except constructor' approve nothing unless an employer is named so", async () => {
  for (const m of ["only constructor", "only the constructor one", "send constructor and 2", "only toString", "yes except constructor"]) {
    const d = cardDb({ n: 3 });
    await d.say("show my applications");
    await d.say(m);
    eq(d.queue.length, 0, `${m}: nothing queued`);
  }
});
Deno.test("PROTO/3 billing: an Object.prototype name is never rewritten by the typo table", () => {
  for (const p of PROTO) eq(billingAsk(`${p}`), null, p);
  eq(billingAsk("cancle my plan"), { kind: "cancel" }, "a real typo is still read");
});
