// Direct answers from code (agent-chat/_shared/direct_answers.ts), each from a live gauntlet failure, 2026-10-12.
// Transactions here are MOCK fixtures.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import * as DirectAnswers from "../../supabase/functions/agent-chat/_shared/direct_answers.ts";
import { connectReply, noDataReply, NO_ACCOUNTS, findMoneyReply, type TxRow } from "../../supabase/functions/agent-chat/_shared/direct_answers.ts";

Deno.test("connect my X answers from the connector matrix, never invented app steps (S16-19)", () => {
  assertMatch(connectReply("connect my fidelity")!, /^Fidelity doesn't let apps place trades, so Upmore tracks it read-only through Plaid .*Connect investments/);
  assertMatch(connectReply("can you connect my schwab account")!, /^Trading at Charles Schwab needs Charles Schwab's approval of Upmore/);
  assertEquals(connectReply("link my kalshi"), "Kalshi isn't available in Upmore, so nothing was connected.");
  assertEquals(connectReply("connect my coinbase"), "Coinbase isn't available in Upmore, so nothing was connected.");
  assertMatch(connectReply("connect my webull")!, /^Upmore can't connect Webull yet: .*Nothing was connected\.$/);
  // The live connector gets the owner's reference design: one line, then the link alone.
  assertEquals(connectReply("connect alpaca"), "Not connected yet - here's the link.\n\nhttps://upmore-srikanthvishnu90-sketchs-projects.vercel.app/connect/alpaca");
  assertEquals(connectReply("connect my gmail"), "Not connected yet - here's the link.\n\nhttps://upmore-srikanthvishnu90-sketchs-projects.vercel.app/connect/gmail");
  for (const t of ["what is fidelity", "connect the dots", "how do i connect"]) assertEquals(connectReply(t), null, t);
  for (const t of ["connect my fidelity", "connect my webull", "connect my cash app", "connect my empower 401k"]) assert(!/SnapTrade|owner|keys/.test(connectReply(t)!), `${t}: no internal words`);
});

// Megadoc Q10 "link my Chase account": banks and cards connect in the app through SimpleFIN Bridge (the Connect bank
// screen), read-only; the brokerage matrix keeps brokerages; a bank's list is never promised.
Deno.test("link my Chase account: the app's real bank path in plain words, no card, no promise the bank is listed (Q10)", () => {
  assertEquals(connectReply("link my Chase account"), "Nothing was connected yet. To connect Chase, open Home in the app and tap Connect bank. It goes through SimpleFIN Bridge: you pick Chase on its list and sign in on the bank's own page, then paste the setup token it gives you into Upmore. Upmore never sees your bank password, and the connection is read-only: it reads balances and transactions and never moves money. If Chase isn't on SimpleFIN's list, it can't be connected yet.");
  assertMatch(connectReply("can you connect my bank")!, /^Nothing was connected yet\. Banks and cards connect from the app: open Home and tap Connect bank\. .*never moves money\.$/);
  for (const t of ["add my checking account", "link my bofa checking", "sync my wells fargo", "connect my amex", "link my discover card"]) assertMatch(connectReply(t)!, /tap Connect bank\. It goes through SimpleFIN Bridge/, t);
  // A bank account kind with a bank's name is the bank, not its brokerage arm; the brokerage words keep the matrix.
  assertMatch(connectReply("connect my ally savings")!, /^Nothing was connected yet\. To connect Ally,/);
  assertMatch(connectReply("link my chase investing account")!, /^J\.P\. Morgan Self-Directed Investing doesn't let apps place trades/);
  assertMatch(connectReply("connect my fidelity")!, /^Fidelity /);
  for (const t of ["add my card", "add chase sapphire", "set up my savings goal", "add my mom", "connect my venmo", "add rent to my budget"]) assertEquals(connectReply(t), null, t);
  assert(!/https?:\/\//.test(connectReply("link my Chase account")!), "no link card: SimpleFIN is a token pasted in the app");
});

// S16-15 "pay my rent" is the standing rent flow now (packages/domain/81-standing-rent.js through the flow router;
// tests/standing-rent.test.cjs, tests/edge/flow-router.test.ts). No direct answer may intercept it with "not built".
Deno.test("pay my rent is not answered from here: no direct answer intercepts it, so the standing rent flow does (S16-15)", async () => {
  for (const t of ["pay my rent", "pls pay the rent", "rent is 1500 now", "stop rent", "pay sam 900 for rent"]) {
    assertEquals(connectReply(t), null, t);
    assertEquals(noDataReply(t, 0), null, t);
    assertEquals(await findMoneyReply(t, "2026-10-12", async () => { throw new Error("no read for a rent message"); }), null, t);
  }
  const mod: Record<string, unknown> = DirectAnswers;
  assert(!("rentReply" in mod) && !("RENT_NOT_BUILT" in mod), "the not-built rent answer is gone");
});

Deno.test("with nothing linked, balance and spending get one plain line, not internal terms (S16-01, 02, 14, 16)", () => {
  for (const t of ["what's my balance", "how much did i spend on food last month", "how am i doing", "did rent go through"]) assertEquals(noDataReply(t, 0), NO_ACCOUNTS, t);
  assertEquals(noDataReply("what's my balance", 2), null, "with accounts linked the planner answers");
  assertEquals(noDataReply("what's a roth ira", 0), null);
  assert(!/retained|posted records|\[F1\]/.test(NO_ACCOUNTS));
});

const row = (id: string, on: string, cents: number, m: string): TxRow => ({ account_id: "mock-card", provider_transaction_id: id, amount_cents: cents, posted_on: on, merchant_raw: m, is_pending: false, is_transfer: false });

Deno.test("find me money ranks what the person's own rows show, with the source and as-of date (S16-18)", async () => {
  const tx: TxRow[] = [];
  let n = 0;
  for (const m of ["2026-07", "2026-08", "2026-09", "2026-10"]) {
    tx.push(row(`f${++n}`, `${m}-07`, -500, "MONTHLY MAINTENANCE FEE"));
    tx.push(row(`n${++n}`, `${m}-03`, -1799, "NETFLIX.COM"));
  }
  const r = (await findMoneyReply("find me money", "2026-10-12", async () => tx))!;
  assertMatch(r, /^Here's where your money is going that you could cut, biggest first:\n1\. \$5\.00 monthly maintenance fee every month: this saves an estimated \$5\.00 a month/);
  assertMatch(r, /From your linked accounts, transactions through 2026-10-07\. Estimates, not savings yet/);
  assertEquals(await findMoneyReply("find me money", "2026-10-12", async () => []), NO_ACCOUNTS);
  assertEquals(await findMoneyReply("how much money do i have", "2026-10-12", async () => tx), null);
});

Deno.test("find me money with only ordinary subscriptions lists them with their monthly total, never a made-up saving", async () => {
  const tx: TxRow[] = [];
  let n = 0;
  for (const m of ["2026-07", "2026-08", "2026-09", "2026-10"]) tx.push(row(`n${++n}`, `${m}-03`, -1799, "NETFLIX.COM"));
  const r = (await findMoneyReply("where can i save", "2026-10-12", async () => tx))!;
  assertMatch(r, /^Nothing stands out as waste, but these repeat \(\$17\.99 a month together\)\. Worth a look:\n1\. NETFLIX\.COM: \$17\.99 monthly\n/);
  assert(!/NaN|undefined/.test(r));
  assert(!/guarantee/i.test(r));
});

// Megadoc Q03, Q04, Q06, Q08: account and privacy asks answered from the app's real screens and the privacy policy.
// Every app path named here is checked against the app source itself, and the processors against /privacy, so a
// renamed button or a changed policy fails this test instead of the chat quoting something that isn't there.
import SRC_APP from "../../src/upmore-app-template.html" with { type: "text" };
import SRC_PRIVACY from "../../privacy.html" with { type: "text" };
const { accountPrivacyReply, whoSeesReply, ACCOUNT_NUMBER_NONE, DELETE_DATA_STEPS, PHONE_NONE, EMAIL_NONE, FEES_REPLY } = DirectAnswers;
import SRC_TERMS from "../../terms.html" with { type: "text" };
import SRC_TRADE from "../../packages/domain/66-agent-trade.js" with { type: "text" };

Deno.test("show my full account number: none is held or shown; the brokerage's last four only (Q03)", () => {
  for (const t of ["show my full account number", "whats my account number", "can you give me my routing number", "send me my full card number", "what is my checking account number?", "i need my full account number"]) assertEquals(accountPrivacyReply(t, "anthropic"), ACCOUNT_NUMBER_NONE, t);
  for (const t of ["what's my account balance", "how many accounts do i have", "my account number changed", "is 1234 my account"]) assertEquals(accountPrivacyReply(t, "anthropic"), null, t);
  assert(!/\d{5,}/.test(ACCOUNT_NUMBER_NONE), "no number in the reply");
  assertMatch(ACCOUNT_NUMBER_NONE, /\*\*\*\*1234/);
  // The You screen does show a connected brokerage as "Connected, live (****1234)".
  assertMatch(SRC_APP, /"Connected, live" \+ \(row\.account_mask \? " \(" \+ row\.account_mask/);
});

Deno.test("delete my data: never done from chat; the app's own Delete data steps, the policy's email and 30 days (Q04)", () => {
  for (const t of ["delete my data", "pls delete my account", "i want to delete all my data", "how do i delete my account?", "delete everything you have on me", "erase my personal info", "forget me", "can you delete my upmore account permanently"]) assertEquals(accountPrivacyReply(t, "anthropic"), DELETE_DATA_STEPS, t);
  for (const t of ["delete my reminder for rent", "delete my bank account", "remove my budget", "delete that charge", "clear everything", "remove my card from netflix", "delete the iou with sam"]) assertEquals(accountPrivacyReply(t, "anthropic"), null, t);
  assertMatch(DELETE_DATA_STEPS, /Nothing was deleted\.$/);
  // Each step named is a real control with that label in the app, on the You screen, and the modal asks for DELETE.
  assertMatch(SRC_APP, /id="profile" aria-label="You">[\s\S]{0,400}?<h1 class="ptitle">You<\/h1>/);
  assertMatch(SRC_APP, /id="deleteData">Delete data</);
  assertMatch(SRC_APP, /id="exportData">Export data</);
  assertMatch(SRC_APP, />Delete everything</);
  assertMatch(SRC_APP, /Type <b>DELETE<\/b> to confirm/);
  // The contact, the 30 days and what is erased are the policy's own words.
  assertMatch(SRC_PRIVACY, /vishnusrikanth8@gmail\.com/);
  assertMatch(SRC_PRIVACY, /We verify you own the account, then complete requests within 30 days/);
  assertMatch(SRC_PRIVACY, /deleting your account erases your profile, chats, progress, saved items, reminders, and your bank\/brokerage connections including stored credentials/);
});

Deno.test("who can see my messages: the person's own rows and the AI provider this deployment runs on, from the policy (Q06)", () => {
  for (const t of ["who can see my messages", "who else can read my chats", "are my chats private?", "do you sell my data", "does anyone else see my messages", "do you train on my data", "is my data safe"]) assertEquals(accountPrivacyReply(t, "anthropic"), whoSeesReply("anthropic"), t);
  for (const t of ["who can see my spending", "can you see my balance", "who sells the cheapest data plan"]) assert(accountPrivacyReply(t, "anthropic") === null || /Upmore's AI provider/.test(accountPrivacyReply(t, "anthropic")!), t);
  assertMatch(whoSeesReply("anthropic"), /which is Anthropic \(Claude\) right now/);
  assertMatch(whoSeesReply("anthropic"), /which is Anthropic \(Claude\) right now/);
  assertMatch(whoSeesReply("anthropic"), /From Upmore's privacy policy, updated Oct 11, 2026 \(You, then Privacy Policy\)\.$/);
  // Both providers are the policy's own list, and its date is the one quoted.
  assertMatch(SRC_PRIVACY, /<strong>Anthropic<\/strong>/);
  assert(!/OpenAI/.test(SRC_PRIVACY), "the policy names no OpenAI");
  assertMatch(SRC_PRIVACY, /not used to train their models by default/);
  assertMatch(SRC_PRIVACY, /Last updated:<\/strong> October 11, 2026/);
  assertMatch(SRC_APP, /id="privacyRow"[^>]*><span class="pl">Privacy Policy</);
  // The in-app Privacy Policy sheet says what /privacy and the code say (it named Anthropic, Plaid for brokerage, "we never
  // move money" and saved merchant logins until 2026-10-12): the chat's "(You, then Privacy Policy)" points at it.
  const sheet = /<div class="sheet" id="privacySheet"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(SRC_APP)![0];
  assertMatch(sheet, /Last updated: October 11, 2026/);
  assertMatch(sheet, /Anthropic \(your Guide messages/);
  assert(!/OpenAI/.test(sheet), "the in-app policy names no OpenAI");
  assertMatch(sheet, /Alpaca \(only if you connect your own brokerage account/);
  for (const stale of [/go to Claude/, /brokerage connection \(Plaid\)/, /merchant logins you/, /we never move money,/]) assert(!stale.test(sheet), String(stale));
});

Deno.test("change my phone number or email: no phone on the account; email changes by asking, nothing changed (Q08)", () => {
  for (const t of ["change my phone number", "i got a new number", "update my cell number", "how do i change my number"]) assertEquals(accountPrivacyReply(t, "anthropic"), PHONE_NONE, t);
  for (const t of ["can i update my email", "change my login email"]) assertEquals(accountPrivacyReply(t, "anthropic"), EMAIL_NONE, t);
  for (const t of ["change my phone plan", "my phone bill went up", "cancel my phone plan", "update my phone carrier"]) assertEquals(accountPrivacyReply(t, "anthropic"), null, t);
  assertMatch(PHONE_NONE, /Nothing was changed\.$/);
  // Sign-up really is email + password or Google: no phone field.
  assert(!/type="tel"/.test(SRC_APP), "the app has no phone input");
});

Deno.test("what are your fees: the Terms' own price, billing not live, no Upmore fee on actions, the sale fees named (Q05)", () => {
  for (const t of ["what are your fees", "what's the pricing", "how much does upmore cost", "do you charge anything", "is upmore free?", "any fees?", "does upmore take a cut", "how much is the app"]) assertEquals(accountPrivacyReply(t, "anthropic"), FEES_REPLY, t);
  for (const t of ["what are the fees on my chase card", "how much is it to send $40", "any fees on this transfer", "what fees did i pay last month", "netflix price", "how much do i owe", "is this charge free", "how much will it cost me to cancel netflix"]) assertEquals(accountPrivacyReply(t, "anthropic"), null, t);
  // Every fact is the Terms' or the app's own.
  const plain = SRC_TERMS.replace(/<[^>]*>/g, "");
  assertMatch(plain, /Upmore costs \$10 per month when subscriptions are live \(billing is not live yet — nothing is charged today\)/);
  assertMatch(plain, /Version 1\.0 — September 27, 2026/);
  assertMatch(plain, /apply only toward Upmore subscription charges/);
  assertMatch(SRC_APP, /Cancel anytime from You → Upmore subscription/);
  // The sale fees are the ones the trade card says (66-agent-trade.js SALE_FEES).
  assertMatch(SRC_TRADE, /SEC and FINRA fees on a sale/);
});

// Megadoc Q07 "do this while I'm asleep": the standing rules and the person's own quiet hours, nothing set up.
import SRC_FLOWS from "../../supabase/functions/_shared/flow_router.ts" with { type: "text" };
import SRC_PROACTIVE from "../../supabase/functions/_shared/proactive.ts" with { type: "text" };
Deno.test("do this while I'm asleep: every money move waits for a yes, cards expire, quiet hours are the person's own (Q07)", () => {
  const { sleepReply } = DirectAnswers;
  const def = sleepReply("can you do this while i'm asleep", { start: 22, end: 7 })!;
  assertMatch(def, /^Nothing that moves money happens while you're asleep: every order, payment and cancellation waits for your one-line yes, and a card you don't answer expires after 10 minutes with nothing done\./);
  assertMatch(def, /Your quiet hours are 10 p\.m\. to 7 a\.m\. your time: only safety alerts and things you asked me to watch come through then/);
  assertMatch(def, /Nothing was set up\.$/);
  assertMatch(sleepReply("handle it overnight", { start: 23, end: 6 })!, /Your quiet hours are 11 p\.m\. to 6 a\.m\./);
  assertMatch(sleepReply("buy it while i sleep", { start: null, end: null })!, /You have no quiet hours set, so alerts come through at any hour/);
  for (const t of ["what did i spend overnight", "i can't sleep, how much do i have", "sleep number bed price", "remind me tonight"]) assertEquals(sleepReply(t, { start: 22, end: 7 }), null, t);
  // The facts it states are the code's: the default quiet hours, the quiet-hours rule and command, the 10-minute card,
  // and no envelope (the only path that moves money without a yes) is ever handed to the flows.
  assertMatch(SRC_PROACTIVE, /quiet_start: 22, quiet_end: 7/);
  assertMatch(SRC_PROACTIVE, /Only safety alerts and things you asked me to watch come through then\./);
  assertMatch(SRC_PROACTIVE, /quiet hours\?\(\?: \(\?:from\|are\|is\)\)\?/);
  assertMatch(SRC_TRADE, /confirm_ttl_ms: o\.confirm_ttl_ms \|\| 10 \* 60000/);
  assert(!/envelopes\s*:/.test(SRC_FLOWS) && !/envelope_autonomy\s*:\s*true/.test(SRC_FLOWS), "no envelope reaches the live flows");
});

// Megadoc Q01, Q02: stock tips and picks get one fixed answer from the advice guard's blocks, never the model's.
import { AgentTrade } from "../../supabase/functions/_shared/router_core.js";
Deno.test("stock tips and the best stock: no pick, no ticker, what Upmore can do instead (Q01, Q02)", () => {
  const { adviceReply, ADVICE_NONE } = DirectAnswers;
  for (const t of ["can you give me stock tips", "what's the best stock", "whats the best stock to buy rn", "any hot stocks?", "is nvda a good buy", "top 5 stocks", "should i buy tesla stock", "which etf should i pick", "what stock would you buy", "should i buy 2 VOO", "should i sell TSLA", "should i dump my NVDA"]) assertEquals(adviceReply(t), ADVICE_NONE, t);
  for (const t of ["what is an etf", "price of VOO", "how's my portfolio", "buy $5 of VOO", "is this a good buy at costco", "tips for budgeting", "whats the best credit card for groceries", "sell 1 share of AAPL", "should i switch spotify to annual", "whats the best tv to buy", "should i buy generic tide", "should i buy nvidia"]) assertEquals(adviceReply(t), null, t);
  // No ticker or fund is ever named in the answer except the example of how to ask for a quote.
  assertEquals(ADVICE_NONE.match(/\b[A-Z]{2,5}\b/g), ["VOO"]);
  // The two examples it gives really are what the trade flow answers: a quote and the portfolio.
  assertEquals((AgentTrade as any).parse("price of VOO").action, "quote");
  assertEquals((AgentTrade as any).parse("how's my portfolio").action, "portfolio");
});

// Megadoc Q09 "I'm traveling in Japan": no travel notice can be filed; the person's day can move to local time.
import { parseCommand } from "../../supabase/functions/_shared/proactive.ts";
Deno.test("traveling in Japan: no travel notice filed, alerts as usual, the time zone command offered and real (Q09)", () => {
  const { travelReply } = DirectAnswers;
  const t = travelReply("I'm traveling in Japan", "America/New_York")!;
  assertMatch(t, /^Have a good trip\. Upmore can't file a travel notice with your bank or card; if yours wants one, it's in that bank's or card's own app\./);
  assertMatch(t, /Say "time zone Asia\/Tokyo", and "time zone America\/New_York" when you're back\. Nothing was changed\.$/);
  assertMatch(travelReply("heads up, we'll be in Paris next week", "America/Chicago")!, /on France time .*"time zone Europe\/Paris"/);
  assertMatch(travelReply("i'm going abroad for 2 weeks", "America/New_York")!, /on local time while you're away\? Say "time zone" and the zone/);
  // Already on that zone: no offer to change it.
  assert(!/Say "time zone/.test(travelReply("I'm in Japan", "Asia/Tokyo")!));
  for (const m of ["how much did i spend traveling", "i'm going to costco", "i'm in a meeting", "i'm going to be late on rent", "what's the time in japan", "i'm traveling, can i afford it?", "i'm flying to"]) assertEquals(travelReply(m, "America/New_York"), null, m);
  // Every zone offered is a real zone the settings command accepts, and the reply after it names the zone.
  for (const z of ["Asia/Tokyo", "Asia/Seoul", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Rome", "Europe/Berlin", "Europe/Amsterdam", "Europe/Zurich", "Europe/Athens", "Europe/Istanbul", "Asia/Jerusalem", "Asia/Kolkata", "Asia/Bangkok", "Asia/Ho_Chi_Minh", "Asia/Singapore", "Asia/Manila", "Atlantic/Reykjavik", "America/Bogota", "America/Lima", "America/Costa_Rica", "America/Jamaica"]) {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    const c: any = parseCommand(`time zone ${z}`, null, Date.parse("2026-10-12T15:00:00Z"));
    assertEquals(c && c.settings && c.settings.time_zone, z, z);
  }
});

// Megadoc N02-N15: everyday scams answered by ScamCheck (packages/domain/109-scam-check.js, depth packet SCAM-CHECK)
// among the early guards, before the direct answers, the flows and the model.
import SRC_HANDLER_SCAM from "../../supabase/functions/agent-chat/handler.ts" with { type: "text" };
import { ScamCheck } from "../../supabase/functions/_shared/router_core.js";
Deno.test("everyday scams run among the early guards, ahead of every other answer (N02-N15)", () => {
  const guard = SRC_HANDLER_SCAM.indexOf("?? tryScamGuard(message) ?? (ScamCheck as any).answer(message) ?? tryServerGuards(message)");
  const direct = SRC_HANDLER_SCAM.indexOf("let direct: string | null = connectReply(message)");
  assert(guard > 0 && guard < direct, "scam check before the direct answers");
  assertMatch((ScamCheck as any).answer("a \"support agent\" called, they asked me to move money to a safe account"), /^Stop: that's a scam\./);
  assertEquals((ScamCheck as any).answer("transfer $50 to my savings"), null);
  // D05: a payee that "changed where to send" money is checked on a number the person already has, before any flow.
  assertMatch((ScamCheck as any).answer("my landlord changed where to send rent"), /^Check that before anything changes: .*Nothing was changed\.$/);
  assertEquals((ScamCheck as any).answer("pay my rent to Mike 1450 on the 1st via zelle"), null);
  assertMatch((ScamCheck as any).answer("someone sent me $50 by mistake and wants it back"), /^Careful: money that arrives "by mistake"/);
});

// Megadoc O09 "I want to YOLO 10k on options": Upmore can't trade options; the trade flow's own refusal, reached even
// when the message isn't order-shaped, with the one plain risk line and the cap when a size was named.
Deno.test("YOLO on options: can't be traded here, nothing placed, one plain risk line, no lecture, no pick (O09)", () => {
  const { optionsReply } = DirectAnswers;
  assertEquals(optionsReply("I want to YOLO 10k on options"), "Upmore can't trade options, so nothing was placed. It can buy or sell stocks and ETFs in your own Alpaca account, each behind your yes, and every order is capped at $5 for now. Plainly: options you buy can expire worthless, losing everything paid for them.");
  assertEquals(optionsReply("can i trade options"), "Upmore can't trade options, so nothing was placed. It can buy or sell stocks and ETFs in your own Alpaca account, each behind your yes. Plainly: options you buy can expire worthless, losing everything paid for them.");
  for (const t of ["yolo 10k on tsla calls", "buy 2 TSLA calls", "i wanna bet my paycheck on 0dte puts"]) assertMatch(optionsReply(t)!, /^Upmore can't trade options, so nothing was placed\./, t);
  for (const t of ["what are my options for paying rent", "should i exercise my stock options from work", "i have rsus and stock options at work, can i sell", "call my bank", "what are puts", "what other options do i have", "buy 2 shares of TSLA"]) assertEquals(optionsReply(t), null, t);
  // The same fact the trade flow refuses with, so the two never disagree.
  assertMatch(SRC_TRADE, /Upmore can't trade options, so nothing was placed\./);
});

// Money actions not built yet (packages/domain/111-not-yet.js, depth packet NOT-YET): in the first direct line, before
// the flows, so the send parser never sees "transfer 1000 from savings to brokerage".
Deno.test("money actions not built yet are said before any flow can misread them (F03 M02 K08-K11 D06 J09 M12 E25)", () => {
  const { notYetReply } = DirectAnswers;
  assertMatch(notYetReply("transfer 1000 from savings to brokerage")!, /^Moving money between your own accounts isn't built yet, so nothing was moved\./);
  assertMatch(notYetReply("report my card stolen")!, /^Report it to your card issuer now/);
  assertEquals(notYetReply("send sam 50 from savings"), null);
  const line = SRC_HANDLER_SCAM.indexOf("?? notYetReply(message) ??"), flows = SRC_HANDLER_SCAM.indexOf("flow = await routeFlows(message");
  assert(line > 0 && line < flows, "before the flows");
  // The phrases it offers really are handled: rent is its own flow, a cancel is the cancel flow, a buy the trade flow.
  assertEquals((AgentTrade as any).parse("buy $5 of VOO").action, "new");
});

// Megadoc H01-H15 copy trading: not built; said however it's phrased, in the trade flow's own words.
Deno.test("copy trading: not built, the disclosure lag said right, an unverifiable source, an ETF bought directly (H-series)", () => {
  const { copyReply, COPY_NONE } = DirectAnswers;
  for (const t of ["copy Nancy Pelosi's trades", "copy Warren Buffett's portfolio with 10k", "copy Leopold but with 50k", "copy Leopold and Buffett half each", "copy it but skip the oil stuff"]) assertEquals(copyReply(t), COPY_NONE, t);
  assertMatch(COPY_NONE, /a member of Congress reports a trade up to 45 days after it, and a fund's 13F comes 45 days after each quarter ends/);
  assertMatch(copyReply("copy that guy from reddit's trades")!, /trades someone posts or tells you about can't be checked/);
  assertMatch(copyReply("copy Cathie Wood's ETF")!, /A fund manager's ETF is itself something you can buy, like any stock: .*capped at \$5 for now\.$/);
  for (const t of ["how did copying Leopold do", "stop copying Leopold", "sell everything I copied"]) assertMatch(copyReply(t)!, /^Copy trading isn't built, so there's no copy running to report on, stop or sell\./, t);
  for (const t of ["copy that", "copy that!", "send me a copy of my statement", "can you copy that text", "copy the link"]) assertEquals(copyReply(t), null, t);
  // The trade flow refuses with the same sentence, so the two never disagree.
  assert(SRC_TRADE.includes(COPY_NONE));
});

// Megadoc O01, O06, O07, O08, O10: hard moments get a short, calm reply with no advice and one offer, each a phrase that
// really reaches an answer from the person's own rows.
import { moneyKind } from "../../supabase/functions/agent-chat/_shared/money_answers.ts";
Deno.test("hard moments: calm, no advice, one offer that reaches a real answer (O01 O06 O07 O08 O10)", () => {
  const { momentReply } = DirectAnswers;
  const laid = momentReply("I got laid off")!, broke = momentReply("I'm so broke")!, lost = momentReply("I lost 8k today in the market")!, night = momentReply("3am can't sleep worried about money")!, scam = momentReply("I feel dumb for losing money on this scam")!;
  assertMatch(laid, /say "how long will my money last"\. Nothing changes unless you ask\.$/);
  assertMatch(broke, /say "how am I doing"\. Just the numbers, no judgment\.$/);
  assertMatch(lost, /^That's a hard day\. I won't tell you what to do next\..*say "how's my portfolio"\.$/);
  assertMatch(night, /say "how am I doing"\. Or I can send a short brief at 8 a\.m\. instead: say "turn on the morning brief"\.$/);
  assertMatch(scam, /^It isn't dumb: .*report it at reportfraud\.ftc\.gov.*say "dispute this charge" and I'll draft what to send your bank\.$/);
  for (const t of [laid, broke, lost, night, scam]) assert(!/\b(?:you should|i recommend|i suggest|don't worry|cheer up|it'll be fine)\b/i.test(t), t);
  for (const t of ["i'm broke, can i afford a $20 dinner?", "my friend got laid off", "i lost my keys", "i'm not broke", "how much did i lose in the market", "i lost $40 on that bet"]) assertEquals(momentReply(t), null, t);
  // Each offered phrase reaches its answer.
  assertEquals(moneyKind("how long will my money last"), "runway");
  assertEquals(moneyKind("how am I doing"), "checkup");
  assertEquals((AgentTrade as any).parse("how's my portfolio").action, "portfolio");
  assertEquals((parseCommand("turn on the morning brief", null, Date.parse("2026-10-12T15:00:00Z")) as any).settings, { morning_brief: true });
});

// Megadoc K12 "what are the terms of this merchant": never summarized from memory; the merchant's own page when on file.
import SRC_MERCHANT_TERMS from "../../packages/connectors/merchant-terms.json" with { type: "text" };
Deno.test("merchant terms: the page on file, never a summary; not on file is said; this merchant is asked (K12)", () => {
  const { termsReply } = DirectAnswers;
  const book = JSON.parse(SRC_MERCHANT_TERMS);
  for (const m of book.merchants) assertMatch(termsReply(`what are ${m.name}'s terms`)!, new RegExp(`^${m.name}'s own terms are at ${m.terms_url.replace(/[.?*+^$()[\]\\/]/g, "\\$&")}\\. I don't summarize them from memory`));
  assertMatch(termsReply("what are the terms of this merchant")!, /^Which merchant\? /);
  assertMatch(termsReply("refund policy for hulu")!, /^I don't have Hulu's terms on file, and I won't make them up\./);
  assertMatch(termsReply("what are your terms")!, /^Upmore's Terms of Service are in the app under You, then Terms of Service/);
  for (const t of ["what are the terms of the loan", "terms of my lease", "terms of this offer", "netflix", "what are the terms"]) assertEquals(termsReply(t), null, t);
  assertMatch(SRC_APP, /id="termsRow"[^>]*><span class="pl">Terms of Service</);
});

// Megadoc I06 "am I accredited": never decided; the SEC's tests from the offer book with source and date; the person attests.
import SRC_TERMS_BOOK from "../../packages/offers/terms.json" with { type: "text" };
Deno.test("am I accredited: never decided, the SEC tests from the offer book with source and date, the person attests (I06)", () => {
  const { accreditedReply } = DirectAnswers;
  const a = accreditedReply("am I accredited", "2026-10-12")!;
  assertMatch(a, /^I can't decide that for you: you attest to it yourself to whoever runs the offering, and they may ask for proof\./);
  // Every number is the offer book's, and the citation is its source and checked date.
  const book = JSON.parse(SRC_TERMS_BOOK).terms, v = (id: string) => book.find((t: any) => t.id === id).value;
  assertEquals([v("sec.accredited.income_individual"), v("sec.accredited.income_joint"), v("sec.accredited.net_worth")], [20000000, 30000000, 100000000]);
  assertMatch(a, /income over \$200,000 \(or \$300,000 together with a spouse or spousal equivalent\).*net worth over \$1,000,000, not counting your home; or a Series 7, 65 or 82 license/);
  assertMatch(a, /\(per SEC, Amendments to the accredited investor definition \(17 CFR 230\.501\(a\)\), small business compliance guide, checked 2026-10-12\)\.$/);
  // A year later the rule is past its window and said as possibly changed, never as current.
  assertMatch(accreditedReply("am I accredited", "2027-10-14")!, /checked 2026-10-12; that may have changed, so check before acting\)\.$/);
  // A definition question is answered without "I can't decide", still never deciding.
  const d = accreditedReply("what is an accredited investor", "2026-10-12")!;
  assertMatch(d, /^Under the SEC's rule, a person generally qualifies as an accredited investor/);
  assertMatch(d, /Upmore never decides it\./);
  for (const t of ["is my school accredited", "accredited college", "what's my balance"]) assertEquals(accreditedReply(t, "2026-10-12"), null, t);
});
