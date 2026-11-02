// Link safety (reqs Q632, Q633): no shortened URL that hides its destination is ever sent, on any channel, shaped or not; the
// words say a link was removed (never a silent gap); a named site (even one whose name looks like a shortener's) stays; an exact
// payload the person approves word for word is never changed. Through shapeForTurn, the function agent-chat's every turn runs.
import assertNode from "node:assert/strict";
import { isShortLink, SHORT_LINK_REMOVED, shapeForTurn, shapeReply } from "../../supabase/functions/_shared/channel_shape.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const SHORT = ["https://bit.ly/3xYzAbc", "http://t.co/abc123", "https://tinyurl.com/acme-job", "https://www.goo.gl/x1", "https://lnkd.in/gAbCdE", "https://rb.gy/q1w2e3", "https://cutt.ly/abc"];
const NAMED = ["https://boards.greenhouse.io/acme/jobs/1", "https://bitly.com/pages/about", "https://acme.co/careers", "https://jobs.lever.co/t/abc", "https://www.linkedin.com/company/acme"];

Deno.test("isShortLink: public shorteners only; a company's own domain is a named site", () => {
  for (const u of SHORT) eq(isShortLink(u), true, u);
  for (const u of NAMED) eq(isShortLink(u), false, u);
  eq(isShortLink("not a url"), false);
});

Deno.test("every channel, shaped or not: a shortened link is removed and the words say so; named links stay", () => {
  const reply = `The Acme posting is here: ${SHORT[0]} and their careers page is ${NAMED[2]}. The recruiter's link was ${SHORT[4]}`;
  for (const [on, channel] of [[false, "imessage"], [false, "whatsapp"], [false, "sms"], [false, "telegram"], [false, "web"], [true, "imessage"]] as const) {
    const r = shapeForTurn({ on, channel, writable: true, reply, allowedLinks: [...SHORT, ...NAMED] });
    for (const u of SHORT) ok(!r.reply.includes(u), `${channel}: ${u} sent`);
    ok(r.reply.includes(NAMED[2]), `${channel}: the named link stays`);
    eq(r.reply.split(SHORT_LINK_REMOVED).length - 1, 2, `${channel}: each removal is said: ${r.reply}`);
    eq(r.notes.filter((n) => /shortened/.test(n)).length, 2, `${channel}: noted`);
  }
});

Deno.test("Telegram with the reply writer on: never in the answer, never as a link message", () => {
  const r = shapeForTurn({ on: true, channel: "telegram", writable: true, reply: `Here it is: ${SHORT[1]}\n${NAMED[0]}`, allowedLinks: [SHORT[1], NAMED[0]] });
  const sent = [r.reply, ...(r.shape?.links ?? []), ...(r.shape?.more ?? [])].join("\n");
  ok(!sent.includes("t.co/"), sent);
  ok((r.shape?.links ?? []).includes(NAMED[0]), "the named posting link is still sent");
  ok(r.reply.includes(SHORT_LINK_REMOVED), r.reply);
  const s = shapeReply({ answer: "See the links.", links: [SHORT[2], NAMED[1]] }, { allowedLinks: null });
  eq(s.links, [NAMED[1]]);
  ok(s.notes.some((n) => /shortened/.test(n)), s.notes.join("|"));
});

Deno.test("an exact payload the person approves word for word is never changed", () => {
  const card = `Send this to Dana?\n"Here is my portfolio: ${SHORT[0]}"`;
  eq(shapeForTurn({ on: false, channel: "imessage", writable: false, reply: card }).reply, card);
  eq(shapeForTurn({ on: true, channel: "telegram", writable: false, reply: card }).reply, card);
});

Deno.test("a reply with no shortened link is returned exactly as it was", () => {
  const reply = `Two roles fit. Acme: ${NAMED[0]}`;
  const r = shapeForTurn({ on: false, channel: "whatsapp", writable: true, reply });
  eq([r.reply, r.shape, r.notes], [reply, null, []]);
});
