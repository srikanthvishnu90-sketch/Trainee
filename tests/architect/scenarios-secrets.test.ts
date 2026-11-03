// OWNER RULE (no passwords, one-time codes or card numbers through chat; owner 2026-10-11, decision 1) at scale: thousands
// of generated messages through the chat input's redaction (supabase/functions/_shared/identity_redact.ts redactIdentity,
// run by agent-chat/_shared/chat_input.ts before anything stores the text or a model sees it).
//   - a password in any common phrasing ("my pw is", "password:", "pass=", "login is <user> / <pw>", "username <u>
//     password <pw>", "creds: <u>/<pw>") is removed; the user name may stay
//   - a one-time code ("code is 123456", "OTP 482913", "verification code: 12 34 56", "my pin is 4821") is removed
//   - a card number (Visa, Mastercard, Discover 16 digits, Amex 15, with spaces, dashes or dots) is removed when it passes
//     the Luhn check, and also when it is labeled a card and mistyped (fails Luhn)
//   - the stored text (chatInput userContent) and the note the person is shown never carry the secret
//   - controls stay exactly as written: phone numbers, zip codes, job ids (16 digits too), salaries, dates, years, order,
//     confirmation and tracking numbers, an unlabeled number that fails Luhn, words about a password
// Seeded (tests/architect/scenarios-fixture.ts); every secret is made at run time. No network, no model.
import assertNode from "node:assert/strict";
import { redactIdentity, redactionNote } from "../../supabase/functions/_shared/identity_redact.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";
import { cards, codes, keptNumbers, luhnOk, PASSWORD_WORDS, passwords, PROSE, rng, type Secret } from "./scenarios-fixture.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);

const PW = passwords(rng(1), 1200), CODES = codes(rng(2), 1000), CARDS = cards(rng(3), 1000), KEPT = keptNumbers(rng(4), 1500);
// Digits as they read with separators between digits removed ("12 34 56" -> "123456").
const joined = (s: string) => s.replace(/(\d)[ .-](?=\d)/g, "$1");
const leaks = (text: string, secret: string) => text.includes(secret) || joined(text).includes(joined(secret));

function check(cases: Secret[], name: string) {
  const fails: string[] = [];
  for (const c of cases) {
    const r = redactIdentity(c.input);
    const stored = chatInput(c.input, undefined, 4000);
    const note = redactionNote(r.removed) ?? "";
    const want = c.kind === "card" ? "card" : c.kind;
    if (leaks(r.text, c.secret) || !r.removed.includes(want as any)) fails.push(`[${c.family}] ${JSON.stringify(c.input)} -> ${JSON.stringify(r.text)} ${JSON.stringify(r.removed)}`);
    else if (!stored.ok || leaks(stored.userContent, c.secret) || leaks(stored.message, c.secret) || leaks(note, c.secret)) fails.push(`[${c.family}] stored or echoed: ${JSON.stringify(c.input)}`);
  }
  if (fails.length) throw new Error(`${fails.length} of ${cases.length} ${name} leaked:\n${[...new Set(fails)].slice(0, 40).join("\n")}`);
}

Deno.test(`${PW.length} generated passwords are removed before storage and never echoed`, () => check(PW, "passwords"));
Deno.test(`${CODES.length} generated one-time codes are removed before storage and never echoed`, () => check(CODES, "codes"));
Deno.test(`${CARDS.length} generated card numbers are removed before storage and never echoed`, () => {
  assertNode.ok(CARDS.filter((c) => luhnOk(c.secret)).length > 600 && CARDS.some((c) => !luhnOk(c.secret)), "both Luhn-valid and mistyped labeled cards are generated");
  check(CARDS, "cards");
});

Deno.test(`${KEPT.length + PASSWORD_WORDS.length + PROSE.length + 1} generated controls (phones, zips, job ids, salaries, dates, years, order numbers, words about a password, resume prose) stay exactly as written`, () => {
  const fails: string[] = [];
  for (const c of KEPT) { const r = redactIdentity(c.input); if (r.text !== c.input || r.removed.length) fails.push(`[${c.family}] ${JSON.stringify(c.input)} -> ${JSON.stringify(r.text)}`); }
  for (const t of [...PROSE, RESUME]) { const r = redactIdentity(t); if (r.text !== t || r.removed.length) fails.push(`[prose] ${JSON.stringify(t.slice(0, 80))} -> ${JSON.stringify(r.text.slice(0, 200))}`); }
  for (const t of PASSWORD_WORDS) { const r = redactIdentity(t); if (r.text !== t || r.removed.length) fails.push(`[password words] ${JSON.stringify(t)} -> ${JSON.stringify(r.text)}`); }
  if (fails.length) throw new Error(`${fails.length} controls were changed:\n${[...new Set(fails)].slice(0, 40).join("\n")}`);
});

Deno.test("a Luhn-valid 13 to 19 digit run is a card wherever it sits; the same digits after an order or job label are a reference", () => {
  const r = rng(5);
  for (let i = 0; i < 300; i++) {
    const c = cards(r, 1)[0];
    const plain = c.secret;
    if (!luhnOk(plain)) continue;
    assertNode.ok(!redactIdentity(`ok so ${plain} is it`).text.includes(plain), plain.length + " digits in a sentence");
    assertNode.equal(redactIdentity(`order #${plain}`).text, `order #${plain}`);
  }
});
