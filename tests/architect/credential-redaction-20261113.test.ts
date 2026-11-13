// Credentials in chat, independent review 2026-11-13 (CLAUDE.md: no password or one-time code is stored or sent through chat;
// a login is the person signing in themselves).
//   1. identity_redact.ts removed a value after a credential cue only when it had a digit or symbol: "...login so you can
//      check it: alex@x.test / hunterpass" and "the portal login, user alex, pass kitty-cat99" were stored as typed. Any value
//      after a password, PIN, one-time code or login-pair cue is now removed before storage, whatever its characters.
//   2. reply_guards.ts credentialAsks missed "send me the 6-digit code they texted you", "text me the code Workday emailed
//      you" and "send over your login". Any reply asking for a code, password, PIN, login or credentials is now caught;
//      telling the person to sign in themselves is not.
// Each is proved through its nearest caller: chatInput (what agent-chat stores) and runAgentTurn (the outbound reply).
//   deno test -A --no-check tests/architect/credential-redaction-20261113.test.ts
import assertNode from "node:assert/strict";
import { redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";
import { credentialAsks } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";
import { runAgentTurn, SECRET_DROPPED_REPLY } from "../../supabase/functions/_shared/agent/loop.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

// [message, the secret that must not survive]
export const MUST_REDACT: [string, string][] = [
  ["here's my workday login so you can check it: alex@x.test / hunterpass", "hunterpass"],
  ["the portal login, user alex, pass kitty-cat99", "kitty-cat99"],
  ["the portal login, user alex, pass kittycat", "kittycat"],
  ["my password is hunterpass", "hunterpass"],
  ["Password: sunshine", "sunshine"],
  ["pw sunshine", "sunshine"],
  ["pwd: bluebird", "bluebird"],
  ["my passcode is tangerine", "tangerine"],
  ["passphrase is moonlightsonata", "moonlightsonata"],
  ["my bank PIN is 7391", "7391"],
  ["pin: 5520", "5520"],
  ["login: alex / hunterpass", "hunterpass"],
  ["credentials are alex:hunterpass", "hunterpass"],
  ["creds alex:sunflower", "sunflower"],
  ["Workday login alex@x.test:hunterpass", "hunterpass"],
  ["sign-in for greenhouse is alex@x.test / maplesyrup", "maplesyrup"],
  ["user alex pass hunterpass", "hunterpass"],
  ["username: alex password: hunterpass", "hunterpass"],
  ["username alex, password hunterpass", "hunterpass"],
  ["USER alex PASS hunterpass", "hunterpass"],
  ["my one-time code is 482913", "482913"],
  ["OTP: 739201", "739201"],
  ["verification code 551234", "551234"],
  ["the verification code is KXQPZW", "KXQPZW"],
  ["my login for workday is alex@x.test and the password is maplesyrup", "maplesyrup"],
  ["Here are my credentials: alex@x.test / maplesyrup", "maplesyrup"],
  ["login alex@x.test / maplesyrup", "maplesyrup"],
  ["LOGIN: alex@x.test / MapleSyrup", "MapleSyrup"],
  ["the password for my greenhouse account is maplesyrup", "maplesyrup"],
  ["use maplesyrup as the password", "maplesyrup"],
  ["passwd=maplesyrup", "maplesyrup"],
  ["pass: maplesyrup", "maplesyrup"],
  ["my pw's maplesyrup", "maplesyrup"],
  ["sign in with alex / maplesyrup", "maplesyrup"],
  ["email alex@x.test password maplesyrup", "maplesyrup"],
  ["the lever login, username alex, password maplesyrup", "maplesyrup"],
  ["here are the sign-in details: alex@x.test / maplesyrup", "maplesyrup"],
  ["Login details - alex@x.test / maplesyrup", "maplesyrup"],
  ["my workday creds are alex@x.test / maplesyrup", "maplesyrup"],
  ["otp is 4821", "4821"],
  ["my icims login so you can check: alexr / snowfall", "snowfall"],
  ["the passcode: snowfall", "snowfall"],
  ["Password = Snowfall", "Snowfall"],
  ["credentials: alex / snowfall", "snowfall"],
  ["user: alex, pass: snowfall", "snowfall"],
  ["my 2fa code is HJKLQW", "HJKLQW"],
  ["Login for Taleo: alex.r@x.test / riverbend, can you check my status?", "riverbend"],
  ["this is my workday sign in, alex@x.test / riverbend", "riverbend"],
];
export const MUST_KEEP: string[] = [
  "I passed the exam",
  "pass on this role",
  "Passport required",
  "US passport and work authorization required",
  "I'll pass, thanks",
  "Can you pass my resume along to the recruiter?",
  "my login email is a@b.test / thanks",
  "email me at a@b.test / or call",
  "contact a@b.test / b@c.test",
  "I forgot my Workday password, what should I do?",
  "my password is wrong",
  "the login page is down",
  "I can't log in to Greenhouse",
  "the verification code expired",
  "user research / design roles",
  "login/signup pages were part of my project",
  "sign in with Google / Apple",
  "My zip code is 60601",
  "the job requires a pass on the background check",
  "I set up SSO / SAML login for 300 users",
  "Season pass holders get a discount",
  "pass the CPA exam by June",
  "credentials: BS in Biology / RN license",
  "my login email is a@b.test / cheers",
  "Must hold a valid passport; travel 20%",
];

Deno.test("CR-1 a value after any credential cue is removed before storage, whatever its characters", () => {
  ok(MUST_REDACT.length >= 40 && MUST_KEEP.length >= 20);
  const missed: string[] = [];
  for (const [m, secret] of MUST_REDACT) {
    const r = redactIdentity(m);
    if (r.text.includes(secret) || !r.removed.length) missed.push(`${m} -> ${r.text}`);
  }
  eq(missed, [], "secrets kept");
  const changed = MUST_KEEP.filter((m) => redactIdentity(m).text !== m).map((m) => `${m} -> ${redactIdentity(m).text}`);
  eq(changed, [], "ordinary text changed");
  // The email of a pair stays; only the secret goes.
  ok(redactIdentity(MUST_REDACT[0][0]).text.includes("alex@x.test"));
});

Deno.test("CR-2 through chatInput, the text agent-chat stores and sends to a model carries no secret", () => {
  for (const [m, secret] of MUST_REDACT) {
    const i = chatInput(m, [], 4000) as any;
    ok(i.ok && !i.userContent.includes(secret) && !i.message.includes(secret) && i.redacted.length, `${m}: ${i.userContent}`);
  }
  for (const m of MUST_KEEP) { const i = chatInput(m, [], 4000) as any; eq([i.userContent, i.redacted], [m, []], m); }
});

export const ASKS: string[] = [
  "Please send me the 6-digit code they texted you.",
  "Text me the code Workday emailed you.",
  "Send over your login.",
  "Send me your Workday password and I'll log in for you.",
  "What's your one-time code?",
  "Can you share your login credentials?",
  "Reply with the verification code when it arrives.",
  "Paste the OTP here.",
  "Forward me the code from the email.",
  "Give me your PIN and I'll finish it.",
  "Tell me the code Greenhouse sent you.",
  "Share your username and password so I can apply.",
  "Could you text me your sign-in details?",
  "Drop your creds here and I'll take it from there.",
  "Send the 4-digit code over.",
  "What code did they send you?",
  "Let me know the code you received.",
  "Please reply with your password.",
  "DM me your login info.",
  "Send me the security code from the text.",
  "I'll need the code they emailed you to continue.",
  "Paste your login here and I'll check the status.",
  "Just send me the passcode.",
  "Can I get the code that iCIMS sent you?",
  "Shoot me the verification code.",
  "Tell me your Workday login and I'll handle it.",
];
export const HONEST: string[] = [
  "Sign in yourself on Workday, then tell me 'done'.",
  "Never send your password here; you sign in yourself on Workday's page.",
  "Workday will text you a code; type it on Workday's page.",
  "Share the posting link and I'll check it.",
  "Once you've logged in, text me 'done'.",
  "Enter the code you got on Workday's page, then tell me done.",
  "Your password should be long.",
  "Send me the job link and I'll tailor your resume.",
  "Share the code samples from your GitHub if you'd like them on your resume.",
  "Tell me once the login works.",
  "Send me a message when you've signed in.",
  "Don't send me any codes; type them on the employer's site.",
  "Paste the job description here.",
  "Text me 'done' after you sign in yourself.",
  "Send me the code you wrote for the project and I'll describe it on your resume.",
  "Give me the login page link if it's not loading and I'll check whether it's down.",
];

Deno.test("CR-3 any reply asking for a code, password, PIN, login or credentials is caught; signing in yourself is not", () => {
  ok(ASKS.length >= 25 && HONEST.length >= 15);
  eq(ASKS.filter((r) => credentialAsks(r).length !== 1), [], "asks missed");
  eq(HONEST.filter((r) => credentialAsks(r).length !== 0), [], "honest replies caught");
});

Deno.test("CR-4 through runAgentTurn, the ask is put back once and then cut before the reply goes out", async () => {
  for (const ask of ASKS.slice(0, 3)) {
    let calls = 0;
    const model = async () => { calls++; return { content: [{ type: "text", text: `${ask} The posting is still open on Stripe's page.` }], stop_reason: "end_turn" }; };
    const t = await runAgentTurn({ system: "s", history: [], message: "is that stripe posting still up?", tools: [], model, ctx: { userId: "u", threadId: "t", now: 0, state: {} } } as any);
    eq([calls, t.reply.trim()], [2, "The posting is still open on Stripe's page."], ask);
    const alone = await runAgentTurn({ system: "s", history: [], message: "check my workday application", tools: [], model: async () => ({ content: [{ type: "text", text: ask }], stop_reason: "end_turn" }), ctx: { userId: "u", threadId: "t", now: 0, state: {} } } as any);
    eq(alone.reply, SECRET_DROPPED_REPLY, ask);
  }
  const honest = HONEST[0];
  const t = await runAgentTurn({ system: "s", history: [], message: "check my workday application", tools: [], model: async () => ({ content: [{ type: "text", text: honest }], stop_reason: "end_turn" }), ctx: { userId: "u", threadId: "t", now: 0, state: {} } } as any);
  eq(t.reply.trim(), honest);
});

// Review round 2 (#825): the second element of a "user / secret" pair after a login cue is the secret, not the user name;
// cue words in Spanish, French, German, Portuguese and Italian; "log in with X and Y"; a whole passphrase. A PIN needs a
// value, not a word ("team PIN is great"); a colon after "sign in" is not a code; two product names are not a pair.
export const MUST_REDACT_2: [string, string][] = [
  ["sign in: alexr / lavender", "lavender"],
  ["login: jsmith / bluebird", "bluebird"],
  ["mot de passe : papillon", "papillon"],
  ["mon mot de passe est papillon", "papillon"],
  ["contraseña: mariposa", "mariposa"],
  ["mi contraseña es mariposa", "mariposa"],
  ["mein Passwort ist Schmetterling", "Schmetterling"],
  ["Kennwort: Schmetterling", "Schmetterling"],
  ["senha: borboleta", "borboleta"],
  ["a minha senha é borboleta", "borboleta"],
  ["la mia password è farfalla", "farfalla"],
  ["código: 739201", "739201"],
  ["el código es 739201", "739201"],
  ["le code est 739201", "739201"],
  ["log in with alex and hunter2", "hunter2"],
  ["sign in with alex@x.test and lavender", "lavender"],
  ["passphrase: correct horse battery staple", "correct horse battery staple"],
  ["my passphrase is correct horse battery staple, thanks", "horse battery staple"],
];
export const MUST_KEEP_2: string[] = [
  "I need to sign in: what's the URL?",
  "I work at Pin Interest, team PIN is great",
  "Login: Workday / Taleo both",
  "creds: CPA / CFA",
  "sign in: Greenhouse / Lever",
  "log in with Google and then open the portal",
  "the PIN is fine",
  "Mot de passe oublié, que faire ?",
];
export const ASKS_2: string[] = [
  "Forward me the email with the code in it.",
  "Mind sending your username and password?",
  "Tell me what the text message code says.",
  "Once the code arrives, just text it to me.",
  "When the code comes in, send it my way.",
];

Deno.test("CR-5 review round 2: pairs, other languages, passphrases; no false PIN, code or product pair; more asks", () => {
  const missed = MUST_REDACT_2.filter(([m, s]) => { const i = chatInput(m, [], 4000) as any; return i.userContent.includes(s) || !i.redacted.length; });
  eq(missed, [], "secrets kept");
  eq(MUST_KEEP_2.filter((m) => (chatInput(m, [], 4000) as any).userContent !== m), [], "ordinary text changed");
  eq(ASKS_2.filter((r) => credentialAsks(r).length !== 1), [], "asks missed");
  eq(HONEST.filter((r) => credentialAsks(r).length !== 0), [], "honest replies caught");
});
