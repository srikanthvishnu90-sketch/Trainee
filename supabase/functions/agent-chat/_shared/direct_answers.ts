// Answers the chat gives from code, not from the model, for asks the live gauntlet (2026-10-12) showed the model getting
// wrong or the flows not covering:
//   - "connect my fidelity": the model invented app steps (S16-19). Now the connector matrix answers: a live connect link,
//     the read-only Plaid path, a fallback while trading waits on approval, not built yet, off, or can't connect.
//   ("pay my rent" used to be answered here as not built. It is now the standing rent flow, packages/domain/81-standing-rent.js,
//   routed by AgentRouter through _shared/flow_router.ts, so nothing here intercepts it.)
//   - "find me money": the model's answer was swapped for a dispute fallback (S16-18). Now the save engine reads the
//     person's own transactions and ranks what it finds, every number from their rows, with the source and as-of date.
//     The subscription and shopping savings (packages/domain/85-subscription-savings.js: cheaper tier, annual switch, perk
//     overlap, rotation, Costco tier, Subscribe and Save) rank alongside, each title citing its offer-book term.
//   - balance and spending with nothing linked: the planner's fallback spoke in internal terms ("retained USD posted
//     records"). Now one plain line says nothing is connected and how to connect it.
// Pure apart from the injected readers, so tests/edge/direct-answers.test.ts drives them with fixtures.
import { BrokerageConnectors, PLATFORMS_JSON, ConnectCards, AgentSave, SubscriptionSavings, OfferBook, OFFER_TERMS_JSON, AdviceGuard, NotYet, MERCHANT_TERMS_JSON } from "../../_shared/router_core.js";

const CONNECT_EMAIL = /^\s*(?:please |pls |can you |could you |can u )?(?:connect|link|add|hook up|sync|set up)\s+(?:my\s+)?(?:gmail|google mail|email|inbox)\b/i;

export function connectReply(message: string): string | null {
  if (CONNECT_EMAIL.test(message)) return ConnectCards.message("gmail");
  // "Connect my Ally savings" is the bank, not Ally Invest: a bank account kind said with a bank's name is the bank's.
  const bank = bankConnectReply(message);
  if (bank && /\b(?:checking|savings|credit cards?|debit card|card|bank)\b/i.test(message)) return bank;
  const a = BrokerageConnectors.connectAnswer(PLATFORMS_JSON, message);
  if (!a) return bank;
  return a.card ? ConnectCards.message(a.card, { lead: a.text }) : a.text;
}

// "Link my Chase account", "connect my bank", "add my checking" (megadoc Q10): banks and cards connect in the app through
// SimpleFIN Bridge (the app's Connect bank screen, src/upmore-app-template.html), read-only. The brokerage matrix answers
// first ("connect my fidelity"); this takes only a bank, a bank account kind, or a bank's name. No card is drawn: only a
// provider a person can connect from the link gets one, and SimpleFIN is a token pasted in the app. Whether SimpleFIN
// lists a given bank is not on file, so it is never promised.
const BANKS: [string, RegExp][] = [["Chase", /\bchase\b/], ["Bank of America", /\bbank of america\b|\bbofa\b|\bboa\b/], ["Wells Fargo", /\bwells fargo\b|\bwells\b/], ["Citi", /\bciti(?:bank)?\b/], ["Capital One", /\bcapital one\b|\bcap one\b/], ["U.S. Bank", /\bu\.?s\.? bank\b/], ["PNC", /\bpnc\b/], ["Ally", /\bally\b/], ["Discover", /\bdiscover\b/], ["American Express", /\bamerican express\b|\bamex\b/], ["Chime", /\bchime\b/], ["Navy Federal", /\bnavy federal\b/], ["USAA", /\busaa\b/], ["TD Bank", /\btd bank\b/], ["Truist", /\btruist\b/], ["Citizens", /\bcitizens(?: bank)?\b/], ["Varo", /\bvaro\b/], ["Marcus", /\bmarcus\b/], ["Synchrony", /\bsynchrony\b/], ["Barclays", /\bbarclays\b/]];
const BANK_ASK = /^\s*(?:please |pls |can you |could you |can u |i want to |i wanna |help me |how do i |how can i )?(?:connect|link|add|hook up|sync|set up)\s+(?:my\s+|our\s+|a\s+)?(.{1,60}?)\s*[?.!]*\s*$/i;
const BANK_WORDS = /^(?:(?:new |other |second )?(?:bank|bank accounts?|checking(?: account)?|savings(?: account)?|credit cards?|debit card|card account|bank and cards?))$/;
export function bankConnectReply(message: string): string | null {
  const m = BANK_ASK.exec(String(message || ""));
  if (!m) return null;
  const what = m[1].toLowerCase().replace(/[’']/g, "'").trim();
  const bank = BANKS.find(([, re]) => re.test(what));
  // "Chase", "my chase account", "chase checking", "chase credit card"; or no name and only an account kind.
  const rest = bank ? what.replace(bank[1], "").replace(/\s+/g, " ").trim() : what;
  if (!(bank ? /^(?:(?:bank )?(?:account|accounts|checking|savings|credit card|card|cards|debit card|bank)(?: account)?)?$/.test(rest) : BANK_WORDS.test(rest))) return null;
  const name = bank ? bank[0] : "your bank";
  return `Nothing was connected yet. ${bank ? `To connect ${name}, open Home in the app and tap Connect bank.` : "Banks and cards connect from the app: open Home and tap Connect bank."} It goes through SimpleFIN Bridge: you pick ${bank ? name : "your bank"} on its list and sign in on the bank's own page, then paste the setup token it gives you into Upmore. Upmore never sees your bank password, and the connection is read-only: it reads balances and transactions and never moves money.${bank ? ` If ${name} isn't on SimpleFIN's list, it can't be connected yet.` : ""}`;
}

// "What's my credit score": no credit bureau or score feed is connected (capability items 37 and 101), and the reply guard
// polices dollar amounts only, so the model could state a made-up score. Code answers the person's own score; how-to
// questions ("how do I improve my credit score", "does closing a card hurt it") still go to the model with the FICO facts,
// and anything about a credit card, limit or report is not a score.
const MY_SCORE = /\b(?:what(?:'?s| is)|whats|check|see|show(?: me)?|tell me|look up|pull|get|know|did|has|how(?:'?s| is| has))\b[^?.!]{0,30}?\bmy (?:credit(?: score)?|fico(?: score)?|vantage ?score)s?\b(?! (?:cards?|limits?|lines?|reports?|union|balance))/i;
const SCORE_HOWTO = /\bhow (?:do|can|could|should|to|would)\b|\bwhat (?:affects|hurts|helps|lowers|raises|impacts)\b|\b(?:does|do|will|would|could|should)\b(?! you\b| u\b)|\bwhat(?:'?s| is) a (?:good|bad)\b/i;
export const CREDIT_SCORE_NONE =
  "I can't see your credit score: no credit bureau or score source is connected to Upmore, so I won't guess at a number. Many card issuers and banks show a free score in their app, and AnnualCreditReport.com gives you your free credit reports from all three bureaus (reports, not scores).";
export function creditScoreReply(message: string): string | null {
  const m = String(message || "");
  return MY_SCORE.test(m) && !SCORE_HOWTO.test(m) ? CREDIT_SCORE_NONE : null;
}

// "Let me test ideas with paper trading": everything is live (owner rule, 2026-10-11): no paper trading, practice
// accounts or paper fallback anywhere, so code says so instead of letting the model offer one. Paper towels, a paper
// statement fee, a paper check or return, and practice budgeting are not trading asks.
const PAPER_TRADING = /\b(?:paper[- ]?trad(?:e|es|ing)|paper (?:account|mode|portfolio|money)|practice (?:trading|trades?|brokerage|account|portfolio)|demo (?:account|trading|mode|portfolio)|fake money|play money|simulat(?:e|ed|ion|ing) (?:a |an |my )?(?:trades?|trading|orders?|buys?|portfolio|stock))\b/i;
export const PAPER_TRADING_NONE =
  "Upmore doesn't offer paper trading or practice accounts: every order is real, in your own brokerage account, placed only after your yes, and capped at $5 an order for now. Nothing was placed.";
export function paperTradingReply(message: string): string | null {
  return PAPER_TRADING.test(String(message || "")) ? PAPER_TRADING_NONE : null;
}

// No phone calls (standing rule). An ask for Upmore itself to place a call is answered here, after the capability
// scripts (which tell the person what to say when they call), so the model never promises one. "Call me when...",
// call options, margin calls, a phone bill, "how do I call" and "should I call" are not asks to place a call.
const NOT_A_CALL = "(?!me\\b|you\\b|it\\b|this\\b|that\\b|or\\b|bill|number|plan|line|case|charger|options?\\b|puts?\\b|on\\b)";
const PHONE_ASK = [
  new RegExp(`^\\s*(?:(?:hey|ok|okay|so|um)[,\\s]+)?(?:(?:can|could|would|will) (?:you|u|upmore) (?:please |pls )?|please |pls |plz )?(?:call|phone|ring|dial)(?: up)? ${NOT_A_CALL}\\S`, "i"),
  new RegExp(`\\b(?:need|want|get) (?:you|upmore) to (?:call|phone|ring)(?: up)? ${NOT_A_CALL}\\S`, "i"),
];
export const PHONE_CALL_NONE =
  "I don't make phone calls, so I haven't called anyone. If you call them yourself, I can tell you what to say and what to ask for; or tell me what it's about and I'll check whether it can be done online instead.";
export function phoneCallReply(message: string): string | null {
  const m = String(message || "");
  return PHONE_ASK.some((re) => re.test(m)) ? PHONE_CALL_NONE : null;
}

// Account and privacy asks (megadoc Q03, Q04, Q06, Q08), answered from what the app and the privacy policy actually say
// (src/upmore-app-template.html: the You screen's "Export data" and "Delete data"; privacy.html, 2026-10-11), never from
// the model, which would guess at settings screens and processors:
//   - "show my full account number": Upmore never receives one (the bank connection sends names, balances and
//     transactions; a brokerage keeps only its last four), and none goes in chat.
//   - "delete my data": never done from chat; the app's Delete data (type DELETE) or an email to the policy contact.
//   - "who can see my messages": stored in the person's own rows, sent to the AI provider this deployment runs on
//     (modelConfig's provider, so the answer follows the MODEL_PROVIDER secret), nobody else.
//   - "change my phone number" / "my email": Upmore has no phone number on file; changing the sign-in email is by email.
const ACCOUNT_NUMBER = [
  /\b(?:show|give|send|tell|text|read|what(?:'?s| is| are)|whats|need|get|find|see)\b[^?.!]{0,24}?\bmy (?:full |whole |complete |entire |real )?(?:bank |checking |savings |credit card |debit card |card |brokerage )?(?:account|routing|card) (?:number|#|no\.?)s?\b/i,
  /\b(?:full|whole|complete|unmasked) (?:bank |checking |savings )?(?:account|card|routing) numbers?\b/i,
];
export const ACCOUNT_NUMBER_NONE =
  "I don't have your account number, and I wouldn't put one in chat. Your bank connection is read-only: it sends Upmore account names, balances and transactions, never account, routing or card numbers. A connected brokerage keeps only its last four, like ****1234, which the You screen shows. For the full number, use your bank's own app or a statement.";
const DELETE_ASK = /^\s*(?:(?:hey|ok|okay|so|um)[,\s]+)?(?:please |pls |can you |could you |can u |i want to |i wanna |i'?d like to |i need to |how (?:do|can) i |help me |go ahead and )?(?:delete|erase|wipe|purge|remove)\s+(?:all\s+(?:of\s+)?)?(?:my\s+)?(?:data|upmore account|upmore data|account and (?:all )?(?:my )?data|personal (?:data|info(?:rmation)?)|information|info|everything(?: you (?:have|know|store)(?: on| about) me)?|my account|account)\s*(?:from upmore|on upmore|with upmore|for good|permanently|completely)?\s*(?:please|pls)?\s*[?.!]*\s*$|^\s*(?:please |pls )?(?:forget (?:about )?me|forget everything(?: about me)?|close my upmore account)\s*[?.!]*\s*$/i;
export const DELETE_DATA_STEPS =
  "I can't delete your account from chat; that's on purpose, since it can't be undone. In the app: You, then Delete data at the bottom; type DELETE and tap Delete everything. That erases your profile, chats, progress, saved items, reminders, and your bank and brokerage connections including their stored credentials, and deletes your account right away, so you can't sign in with this email afterward.\nWant a copy first? Export data is right next to it. Or email vishnusrikanth8@gmail.com from your account email: Upmore confirms the account is yours, then finishes within 30 days.\nNothing was deleted.";
const WHO_SEES = [
  /\bwho (?:else )?(?:can|could|gets to|is able to|will|would) (?:see|read|access|view|look at)\b[^?.!]{0,30}?\b(?:messages|chats?|texts|conversations?|data|info|information)\b/i,
  /\b(?:are|is) my (?:messages|chats?|texts|conversations?|data|info|information) (?:private|safe|secure|shared|encrypted|being (?:read|shared|sold))\b/i,
  /\b(?:do|does|will) (?:you|upmore|anyone(?: else)?|anybody(?: else)?|a human|humans|people|someone) (?:sell|share|read|see|train on|use)\b[^?.!]{0,12}?\bmy (?:messages|chats?|texts|conversations?|data|info|information)\b/i,
];
export function whoSeesReply(provider: "openai" | "anthropic"): string {
  const ai = provider === "anthropic" ? "Anthropic (Claude)" : "OpenAI";
  return `Your messages are stored in your own Upmore account so the conversation keeps its thread; database access is restricted so only your account can read its rows. To write each answer they're sent to Upmore's AI provider, which is ${ai} right now; under its API terms, data sent through the API isn't used to train its models by default. Nobody else: Upmore never sells your data and has no ads or third-party trackers. Deleting your account (You, then Delete data) erases your chats.\nFrom Upmore's privacy policy, updated Oct 11, 2026 (You, then Privacy Policy).`;
}
const PHONE_CHANGE = /\b(?:change|update|edit|switch|replace|fix)\b[^?.!]{0,12}?\bmy (?:phone(?: number)?|cell(?: phone)?(?: number)?|mobile(?: number)?|number)\b(?! (?:plan|bill|carrier|provider|company|payment))|\bi (?:got|have) a new (?:phone )?number\b/i;
const EMAIL_CHANGE = /\b(?:change|update|edit|switch|replace|fix)\b[^?.!]{0,12}?\bmy (?:login |sign[- ]?in |account )?email(?: address)?\b/i;
export const PHONE_NONE =
  "There's no phone number on your Upmore account to change: you sign in with your email (or Google), and texting Upmore from your phone isn't open yet. If you meant the email you sign in with, that can't be changed in the app yet; email vishnusrikanth8@gmail.com from your current account email to ask, and Upmore confirms the account is yours first. Nothing was changed.";
export const EMAIL_NONE =
  "Changing the email you sign in with isn't in the app yet. Email vishnusrikanth8@gmail.com from your current account email to ask, and Upmore confirms the account is yours first. Nothing was changed.";
// "what are your fees" (megadoc Q05): the Terms of Service's own price (terms.html v1.0, section 4) and the app's own
// cancel path; no fee of Upmore's on an order, payment or cancellation, and the broker's pass-through sale fees named.
const FEES = [
  /\b(?:what are|what'?s|whats|what is|tell me) (?:your|upmore'?s|the app'?s) (?:fees?|pricing|prices?|costs?|charges?)\b/i,
  /^\s*(?:what are|what'?s|whats|what is) the (?:fees?|pricing|price|cost)\s*\??\s*$/i,
  /\bhow much (?:is|does|do|will) (?:upmore|this app|the app|you)(?: cost| charge| take)?\b(?! (?:me )?(?:to|for|on|at)\b)/i,
  /\b(?:do|will|does) (?:you|upmore) (?:charge|take a (?:cut|fee)|make money|have fees)\b/i,
  /\bis (?:upmore|this app|the app|this) free\b/i,
  /^\s*(?:are there |any )(?:any )?(?:hidden )?fees\s*\??\s*$/i,
  /\bupmore(?:'s)? (?:fees?|pricing|price|cost|subscription price)\b/i,
];
export const FEES_REPLY =
  "Upmore costs $10 a month once billing launches; billing isn't live yet, so nothing is charged today. Cancel anytime from You, then Upmore subscription. Upmore adds no fee of its own to an order, a payment or a cancellation; anything a broker or payment service charges is on the card before you say yes (on a sale in your Alpaca account, the SEC and FINRA fees Alpaca passes through). Referral credits only lower your Upmore bill; they aren't cash.\nFrom Upmore's Terms of Service (v1.0, Sep 27, 2026), section 4.";
export function accountPrivacyReply(message: string, provider: "openai" | "anthropic"): string | null {
  const m = String(message || "");
  if (FEES.some((re) => re.test(m))) return FEES_REPLY;
  if (ACCOUNT_NUMBER.some((re) => re.test(m))) return ACCOUNT_NUMBER_NONE;
  if (DELETE_ASK.test(m)) return DELETE_DATA_STEPS;
  if (WHO_SEES.some((re) => re.test(m))) return whoSeesReply(provider);
  if (PHONE_CHANGE.test(m)) return PHONE_NONE;
  if (EMAIL_CHANGE.test(m)) return EMAIL_NONE;
  return null;
}

// "do this while I'm asleep" (megadoc Q07): what runs with nobody watching, from the standing rules and the person's own
// quiet hours (agent_proactive_settings, or the default 10 p.m. to 7 a.m.): nothing that moves money happens without
// that person's one-line yes, an unanswered card expires in 10 minutes with nothing done, and only safety alerts and
// their own watches come through in quiet hours (_shared/proactive.ts). Nothing is set up here.
const ASLEEP = /\bwhile (?:i(?:'?m| am) (?:asleep|sleeping|in bed)|i (?:sleep|am sleeping))\b|\b(?:do|handle|run|take care of) (?:it|this|that|them|everything) (?:overnight|tonight while)\b|\b(?:overnight|while i sleep) (?:without|w\/o) (?:me|asking)\b/i;
const hour12 = (h: number) => `${h % 12 || 12} ${h < 12 ? "a.m." : "p.m."}`;
export function sleepReply(message: string, quiet: { start: number | null; end: number | null }): string | null {
  if (!ASLEEP.test(String(message || ""))) return null;
  const q = quiet.start != null && quiet.end != null
    ? `Your quiet hours are ${hour12(quiet.start)} to ${hour12(quiet.end)} your time: only safety alerts and things you asked me to watch come through then; the rest waits until they end. Change them with "quiet hours 11pm to 6am".`
    : `You have no quiet hours set, so alerts come through at any hour; set them with "quiet hours 10pm to 7am".`;
  return `Nothing that moves money happens while you're asleep: every order, payment and cancellation waits for your one-line yes, and a card you don't answer expires after 10 minutes with nothing done. What runs on its own are the checks you've turned on (alerts, watches and reminders). ${q} Nothing was set up.`;
}

// "can you give me stock tips", "what's the best stock" (megadoc Q01, Q02): no securities advice is a standing rule, so a
// request the advice guard (packages/domain/45-advice-guard.js) blocks is answered here, never left to the model:
// what Upmore won't do, what it can (a quote, the person's own holdings and gain, an order they decide on), no ticker
// named. The trade flow refuses the same shapes inside an order.
export const ADVICE_NONE =
  "I don't give stock tips or picks, so I won't say what to buy, sell or hold. What I can do: show a quote (\"price of VOO\"), your own holdings and how they've done (\"how's my portfolio\"), and when you decide, name the ticker and the amount and I'll put up a card for exactly that, which still needs your yes.";
// The guard's "should I" and "best" shapes are not about securities on their own ("should i switch spotify to annual",
// "best tv to buy" belong to their own answers), so the block counts here only with a securities word, or on the
// guard's tips and "is X a good buy" rule, which is securities-only. A bare "should i buy nvidia" goes on to the trade
// flow, which refuses it in its own words.
const SECURITIES = /\b(?:stocks?|shares?|etfs?|(?:index |mutual )?funds?|bonds?|tickers?|invest(?:ing|ment|ments|or)?|portfolio|options?|crypto|coins?|dividends?|s&p|nasdaq|equities)\b/i;
export function adviceReply(message: string): string | null {
  const m = String(message || ""), g = (AdviceGuard as any).request(m);
  if (!g || g.decision !== "block") return null;
  // A ticker as people write one counts as a securities word: "should i buy 2 VOO", "should i sell TSLA", "$NVDA".
  const ticker = /\b\d+(?:\.\d+)?\s+(?:shares?\s+(?:of\s+)?)?[A-Z]{1,5}\b|\$[A-Z]{1,5}\b|\b(?:buy|sell|hold|dump|trim)\s+(?:my\s+)?[A-Z]{2,5}\b/.test(m);
  return (g.reasons || []).includes("tips_or_good_buy") || SECURITIES.test(m) || ticker ? ADVICE_NONE : null;
}

// "I'm traveling in Japan" (megadoc Q09): Upmore can't file a travel notice (no bank or card write), so it says where
// that lives, what still works, and offers the person's day on local time: "time zone Asia/Tokyo" is the settings
// command (_shared/proactive.ts) that moves quiet hours, reminders and briefs. Only countries on one time zone get a zone
// named; anywhere else the person is asked to name the zone. Nothing is changed here.
const TRAVEL = /^\s*(?:(?:hey|fyi|ok|so|heads up)[,:!\s]+)*(?:i'?m|i am|i'?ll be|i will be|we'?re|we are|we'?ll be|i'?m going to be|going to be)\s+(?:travel(?:l)?ing|on (?:a )?(?:trip|vacation|holiday)|abroad|overseas|out of the country|flying|heading|going|in)\b([^?]{0,60})$/i;
const COUNTRY_ZONES: Record<string, [string, string]> = {
  japan: ["Japan", "Asia/Tokyo"], tokyo: ["Japan", "Asia/Tokyo"], korea: ["South Korea", "Asia/Seoul"], "south korea": ["South Korea", "Asia/Seoul"], seoul: ["South Korea", "Asia/Seoul"],
  uk: ["the UK", "Europe/London"], england: ["the UK", "Europe/London"], london: ["the UK", "Europe/London"], scotland: ["the UK", "Europe/London"], ireland: ["Ireland", "Europe/Dublin"],
  france: ["France", "Europe/Paris"], paris: ["France", "Europe/Paris"], italy: ["Italy", "Europe/Rome"], rome: ["Italy", "Europe/Rome"], germany: ["Germany", "Europe/Berlin"],
  netherlands: ["the Netherlands", "Europe/Amsterdam"], amsterdam: ["the Netherlands", "Europe/Amsterdam"], switzerland: ["Switzerland", "Europe/Zurich"], greece: ["Greece", "Europe/Athens"],
  turkey: ["Turkey", "Europe/Istanbul"], israel: ["Israel", "Asia/Jerusalem"], india: ["India", "Asia/Kolkata"], thailand: ["Thailand", "Asia/Bangkok"], vietnam: ["Vietnam", "Asia/Ho_Chi_Minh"],
  singapore: ["Singapore", "Asia/Singapore"], philippines: ["the Philippines", "Asia/Manila"], iceland: ["Iceland", "Atlantic/Reykjavik"], colombia: ["Colombia", "America/Bogota"],
  peru: ["Peru", "America/Lima"], "costa rica": ["Costa Rica", "America/Costa_Rica"], jamaica: ["Jamaica", "America/Jamaica"],
};
export function travelReply(message: string, tz: string): string | null {
  const m = TRAVEL.exec(String(message || ""));
  if (!m || /\b(?:spend|spent|cost|budget|how much|afford)\b/i.test(m[0])) return null;
  const rest = ` ${m[1].toLowerCase().replace(/[.!,]/g, " ")} `;
  const hit = Object.keys(COUNTRY_ZONES).sort((a, b) => b.length - a.length).find((k) => rest.includes(` ${k} `));
  if (!hit && !/\b(?:abroad|overseas|out of the country|trip|vacation|holiday|traveling|travelling)\b/i.test(m[0])) return null;
  const [place, zone] = hit ? COUNTRY_ZONES[hit] : [null, null];
  const local = zone && zone !== tz
    ? ` Want quiet hours, reminders and briefs on ${place} time while you're there? Say "time zone ${zone}", and "time zone ${tz}" when you're back.`
    : zone ? "" : ` Want quiet hours, reminders and briefs on local time while you're away? Say "time zone" and the zone, like "time zone Europe/Paris", and "time zone ${tz}" when you're back.`;
  return `Have a good trip. Upmore can't file a travel notice with your bank or card; if yours wants one, it's in that bank's or card's own app. Charges you make there still show up in your linked transactions, and alerts work as usual.${local} Nothing was changed.`;
}

// "I want to YOLO 10k on options" (megadoc O09): Upmore can't trade options (the trade flow refuses them,
// 66-agent-trade.js "options_unsupported"), but the router only sends an order-shaped message there, so a YOLO, a "can i
// trade options" or a bet on calls went to the model. The same fact from code, the one plain risk line, the $5 cap
// when a size was named, no lecture and no pick.
const OPTIONS = /\b(?:options?|calls|puts|call options?|put options?|contracts|0dte|leaps)\b/i;
const OPTIONS_INTENT = /\b(?:yolo|trade|trading|buy|buying|sell|selling|bet|betting|gamble|put (?:it|\$?\d[\d,.]*k?) (?:all )?(?:in|into|on)|go all in|all in on|throw)\b/i;
const OPTIONS_NOT = /\b(?:stock options? (?:at|from) (?:work|my job)|employee (?:stock )?options?|rsus?|esop|options? to (?:pay|save|cut)|payment options?|what are my options|other options?|options? for (?:rent|paying|my bills|debt|loans?))\b/i;
export function optionsReply(message: string): string | null {
  const m = String(message || "");
  if (!OPTIONS.test(m) || !OPTIONS_INTENT.test(m) || OPTIONS_NOT.test(m)) return null;
  const sized = /\$?\d[\d,.]*\s*(?:k|grand|thousand|dollars|bucks)?\b/i.test(m.replace(/\b(?:0dte|\d+ ?(?:shares?|contracts?))\b/gi, "")) && /\d/.test(m);
  return `Upmore can't trade options, so nothing was placed. It can buy or sell stocks and ETFs in your own Alpaca account, each behind your yes${sized ? ", and every order is capped at $5 for now" : ""}. Plainly: options you buy can expire worthless, losing everything paid for them.`;
}

// Money actions Upmore can't do yet (packages/domain/111-not-yet.js, megadoc D06 D07 E25 F03 J09 J14 K08-K11 M02
// M12): said plainly here, ahead of the flows, so "transfer 1000 from savings to brokerage" is never a payment to
// someone called "brokerage" and the model never says a card was locked.
export function notYetReply(message: string): string | null {
  return (NotYet as any).answer(String(message || ""));
}

// Copy trading (megadoc H01-H15): not built. The trade flow says so when a message reaches it (66-agent-trade.js
// "copy_not_built"); "copy Nancy Pelosi's trades", "copy that guy from reddit's trades" or "how did copying Leopold do"
// never did, and went to the model. The same words from code, plus what each shape needs said: a claimed trade from a
// stranger can't be checked; a fund manager's ETF can be bought directly like any stock, behind a yes; there is no copy
// to report on. Nothing placed, nothing named as a pick.
const COPY = /\b(?:copy|copying|copied|mirror|mirroring|replicate|replicating|clone)\b[^.?!]{0,60}\b(?:portfolio|trades?|holdings|picks|positions|moves|etfs?|funds?|pelosi|buffett|congress|senator|cathie|ark|leopold|him|her|them|guy|investor|hedge fund)\b|\b(?:stop|cancel|end) copying\b|\bhow did (?:copying|the copy|my copy)\b|\bsell everything i copied\b/i;
const COPY_IT = /^\s*(?:ok |okay |so |and )?copy (?:it|them|those|his|hers|his portfolio|her portfolio)\b(?! (?:text|link|message|number|address|code|down|paste))/i;
const COPY_NOT = /\bcopy of (?:my |the |a )?(?:statement|receipt|bill|card|id|w-?2|1099|tax|lease|contract|invoice)\b/i;
export const COPY_NONE =
  "Copy trading isn't built yet, so nothing was placed. Public disclosures also arrive late: a member of Congress reports a trade up to 45 days after it, and a fund's 13F comes 45 days after each quarter ends, so a copy would buy stale positions. Want to see your own holdings instead?";
export function copyReply(message: string): string | null {
  const m = String(message || "");
  if (!(COPY.test(m) || COPY_IT.test(m)) || COPY_NOT.test(m)) return null;
  if (/\b(?:stop|cancel|end) copying\b|\bhow did (?:copying|the copy|my copy)\b|\bsell everything i copied\b/i.test(m)) return "Copy trading isn't built, so there's no copy running to report on, stop or sell. Nothing was changed. Want to see your own holdings instead?";
  if (/\b(?:reddit|twitter|tiktok|discord|youtube|x\.com|some guy|that guy|a guy|stranger|friend)\b/i.test(m)) return "Copy trading isn't built yet, so nothing was placed. And trades someone posts or tells you about can't be checked: there's no filing behind them, so there'd be nothing real to copy. Want to see your own holdings instead?";
  if (/\b(?:etfs?|funds?|cathie|ark)\b/i.test(m) && !/\b(?:hedge fund|portfolio)\b/i.test(m)) return "Copy trading isn't built yet, so nothing was placed. A fund manager's ETF is itself something you can buy, like any stock: name the ticker and the amount and I'll put up a card for exactly that, which still needs your yes and is capped at $5 for now.";
  return COPY_NONE;
}

// Hard moments (megadoc O01, O06, O07, O08, O10): short, calm, no advice, no cheerleading, and one offer the person can
// take up in their own time, each a phrase that really reaches an answer from their own rows ("how long will my money
// last" is the runway, "how am I doing" the checkup, "how's my portfolio" the holdings, "turn on the morning brief" the
// 8 a.m. brief, "dispute this charge" the drafted dispute). Nothing is set up or moved.
const MOMENTS: [string, RegExp, string][] = [
  ["scam_shame", /\b(?:feel|felt|i'?m|i am) (?:so |really |pretty )?(?:dumb|stupid|like an idiot|embarrassed|ashamed|naive)\b[^.?!]{0,50}\b(?:scam|scammed|fraud|got taken|conned)\b|\bi (?:got|was|just got|have been) (?:scammed|conned)\b/i,
    "It isn't dumb: these scams are built to fool careful people. What helps now: tell your bank right away and ask about disputing or recalling the payment, report it at reportfraud.ftc.gov, and change any password or code you shared. If it was a card charge, say \"dispute this charge\" and I'll draft what to send your bank."],
  ["laid_off", /\b(?:i (?:just )?(?:got|was|have been|'ve been) (?:laid off|fired|let go)|(?:i )?lost my job|i'?m (?:now )?(?:unemployed|out of work|between jobs))\b/i,
    "I'm sorry, that's a hard one. When you want it, I can work out how long your money lasts at your current spending, from your own accounts: say \"how long will my money last\". Nothing changes unless you ask."],
  ["lost_market", /\bi (?:just )?lost \$?\d[\d,.]*k?(?: dollars| bucks| grand)?\b[^.?!]{0,30}\b(?:in|on) (?:the )?(?:market|stock market|stocks?|trading)\b|\b(?:lost|down) (?:big|a lot|so much|everything)\b[^.?!]{0,20}\b(?:in|on) (?:the )?(?:market|stocks?)\b/i,
    "That's a hard day. I won't tell you what to do next. If you want the facts, I can show your holdings and how each has done since you bought: say \"how's my portfolio\"."],
  ["worried_night", /\b(?:can'?t sleep|cannot sleep|up all night|lying awake|wide awake)\b[^.?!]{0,50}\b(?:money|bills|rent|debt|finances|broke)\b|\b(?:worried|stressed|anxious|panicking|freaking out) (?:about|over) (?:money|my finances|my bills|bills|rent|my debt|debt)\b/i,
    "Money worries feel bigger at night. If you want the numbers now, say \"how am I doing\". Or I can send a short brief at 8 a.m. instead: say \"turn on the morning brief\"."],
  ["broke", /^\s*(?:(?:ugh|man|honestly|lol)[,!.\s]+)*i'?m (?:so |really |completely |totally |dead |flat )?(?:broke|out of money|poor)(?: af| rn| right now| again)?\s*[.!]*\s*$|^\s*i have no money(?: left)?\s*[.!]*\s*$/i,
    "That's a rough feeling. If it would help, I can lay out where things stand right now, from your own accounts: say \"how am I doing\". Just the numbers, no judgment."],
];
export function momentReply(message: string): string | null {
  const m = String(message || "");
  for (const [, re, text] of MOMENTS) if (re.test(m)) return text;
  return null;
}

// "What are the terms of this merchant" (megadoc K12): terms are never summarized from memory. A merchant whose terms page
// is on file (packages/connectors/merchant-terms.json) gets that page, said as theirs to read; any other gets "not on
// file" and where such pages usually are; "this merchant" with no name is asked; Upmore's own terms are /terms (You,
// then Terms of Service).
const TERMS_ASK = /\b(?:what are|what're|whats|what's|show me|tell me|read me|where are|where can i (?:find|read))?\s*(?:the |their |its )?(?:terms(?: of (?:service|use))?|refund policy|cancellation policy|return policy|fine print)\b\s*(?:of|for|at|from|on)\s+(?:the )?([a-z0-9&'.+ -]{2,40}?)\s*[?.!]*\s*$|^\s*(?:what are |what're |whats |what's |show me |tell me )?([a-z0-9&'.+ -]{2,30}?)'s (?:terms(?: of (?:service|use))?|refund policy|cancellation policy|return policy|fine print)\s*[?.!]*\s*$/i;
export function termsReply(message: string): string | null {
  const raw = String(message || "").trim();
  if (/^\s*(?:what are |what're |show me |where are )?(?:your|upmore'?s) (?:terms(?: of (?:service|use))?|refund policy|cancellation policy)\s*[?.!]*\s*$/i.test(raw)) return "Upmore's Terms of Service are in the app under You, then Terms of Service (also at /terms).";
  const m = TERMS_ASK.exec(raw);
  if (!m) return null;
  const who = String(m[1] || m[2] || "").trim();
  // A loan, a lease, a card offer or anything of the person's own is not a merchant's terms page.
  if (/^(?:my|our)\b|\b(?:loan|lease|mortgage|contract|agreement|offer|deal|bonus|promo|trial|card|account|insurance|warranty|apr|rate|bet|policy)\b/i.test(who)) return null;
  if (/^(?:this|that|the|a) (?:merchant|store|company|service|subscription|one)$|^(?:this|that|it)$/i.test(who)) return "Which merchant? Say its name, like \"what are Netflix's terms\", and I'll point you to its own terms page. I don't summarize terms from memory.";
  if (/^(?:upmore|you|your|this app|the app)$/i.test(who)) return "Upmore's Terms of Service are in the app under You, then Terms of Service (also at /terms).";
  const key = who.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit = ((MERCHANT_TERMS_JSON as any).merchants || []).find((x: any) => x.merchant_key === key || String(x.name || "").toLowerCase().replace(/[^a-z0-9]/g, "") === key);
  if (hit) return `${hit.name}'s own terms are at ${hit.terms_url}. I don't summarize them from memory; that page is what applies to you.${hit.cancel_url ? ` To cancel, say "cancel ${hit.name.toLowerCase()}" and I'll put up a cancel card for your yes.` : ""}`;
  const name = who.replace(/\b\w/g, (c) => c.toUpperCase());
  return `I don't have ${name}'s terms on file, and I won't make them up. They're on ${name}'s own site, usually linked as Terms or Help at the bottom of the page or in your account settings.`;
}

// "Am I accredited" (megadoc I06): Upmore never decides it. The SEC's tests are said from the offer book (every number
// with its source and checked date; past its window it says it may have changed), that the person attests to it
// themselves to whoever runs the offering, and that the rule is under review. No judgment about the person.
const ACCREDITED = /\b(?:am i|are we|would i be|do i (?:count|qualify) as|do i qualify|how do i (?:know if i'?m|become|qualify as)|what(?:'s| is| makes)(?: someone| you)?(?: an?)?|am i an?)\s*(?:an? )?accredited(?: investor)?\b|\baccredited investor\b[^.?!]{0,30}\b(?:me|qualify|requirements?|rules?|definition|test)\b/i;
export function accreditedReply(message: string, today: string): string | null {
  if (!ACCREDITED.test(String(message || ""))) return null;
  const book = (OfferBook as any).create(OFFER_TERMS_JSON);
  const t = (id: string) => book.term(id, today);
  const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const ind = t("sec.accredited.income_individual"), joint = t("sec.accredited.income_joint"), nw = t("sec.accredited.net_worth"), lic = t("sec.accredited.licenses");
  const personal = /\b(?:am i|are we|would i|do i|how do i)\b/i.test(String(message));
  return `${personal ? "I can't decide that for you: you attest to it yourself to whoever runs the offering, and they may ask for proof. " : ""}Under the SEC's rule, a person generally qualifies as an accredited investor with income over ${usd(ind.value)} (or ${usd(joint.value)} together with a spouse or spousal equivalent) in each of the last two years and expected again this year; or net worth over ${usd(nw.value)}, not counting your home; or a ${lic.value} license in good standing.${personal ? "" : " You attest to it yourself to whoever runs an offering; Upmore never decides it."} The SEC has proposed changes, so check its page before relying on this (${ind.cite}).`;
}

export const NO_ACCOUNTS =
  "I don't see a connected bank or card yet, so I can't answer that from your own numbers. Connect one in the app (Home, then Connect bank) and ask again.";
const BALANCE_OR_SPEND = /\b(balance|how much (?:money )?(?:do i have|did i spend|have i spent)|what did i spend|spent on|spending|how am i doing|cash flow|net worth|did (?:my )?rent go through)\b/i;
export function noDataReply(message: string, linkedAccounts: number): string | null {
  return linkedAccounts === 0 && BALANCE_OR_SPEND.test(message) ? NO_ACCOUNTS : null;
}

export type TxRow = { account_id: string; provider_transaction_id: string; amount_cents: number | null; posted_on: string | null; merchant_raw: string; is_pending: boolean; is_transfer: boolean | null };
const FIND_MONEY = /^\s*(?:can you |could you |pls |please )?(?:find (?:me )?(?:some )?money|find me savings|where can i save|how (?:can|do) i save(?: money)?|help me save money|save me money)\b/i;
const money = (c: number) => "$" + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export async function findMoneyReply(message: string, today: string, readTx: () => Promise<TxRow[]>): Promise<string | null> {
  if (!FIND_MONEY.test(message)) return null;
  const rows = (await readTx()).filter((r) => !r.is_pending && r.posted_on && Number.isFinite(r.amount_cents));
  if (!rows.length) return NO_ACCOUNTS;
  const tx = rows.map((r) => ({ id: r.provider_transaction_id, account_id: r.account_id, posted_at: r.posted_on, amount: (r.amount_cents as number) / 100, merchant_raw: r.merchant_raw, is_pending: false, is_transfer: !!r.is_transfer }));
  const through = rows.map((r) => r.posted_on as string).sort().slice(-1)[0];
  const found = AgentSave.detect({ today, transactions: tx, accounts: [], bills: [], debts: [] });
  const subsOpps = SubscriptionSavings.opportunities(SubscriptionSavings.find({ today, book: OfferBook.create(OFFER_TERMS_JSON), transactions: rows }));
  const ranked = AgentSave.rank(found.opportunities.concat(subsOpps), null).slice(0, 3);
  const source = `From your linked accounts, transactions through ${through}. Estimates, not savings yet: nothing counts as saved until your next statements show it.`;
  if (ranked.length) {
    return [`Here's where your money is going that you could cut, biggest first:`, ...ranked.map((o: any, i: number) => `${i + 1}. ${o.title}: ${o.reason}`), "Tell me which one and I'll start on it.", source].join("\n");
  }
  const subs = (found.inventory || []).filter((s: any) => Number.isSafeInteger(s.monthly_cents)).sort((a: any, b: any) => b.monthly_cents - a.monthly_cents).slice(0, 5);
  if (subs.length) {
    return [`Nothing stands out as waste, but these repeat (${money(found.run_rate_monthly_cents || 0)} a month together). Worth a look:`, ...subs.map((s: any, i: number) => `${i + 1}. ${s.merchant}: ${money(s.amount_cents)} ${s.interval || "monthly"}`), "Say \"cancel\" and the name for any you don't use.", source].join("\n");
  }
  return `I looked through your transactions and nothing stands out to cut right now: no repeat fees, price increases or duplicate services. ${source}`;
}
