// The file-page batteries' phone check, in one place (websec, signin, signin-r4 all import it).
//
// A page must never show a person's phone number in any form a person could read: E.164, the 10-digit number, the last 7,
// and (sign-in battery) the last 4 standing alone. Before 2026-11-06 the check also looked inside random tokens: a session id
// is fs1. + 64 random hex, so about one CI run in a hundred found a test phone's 7 digits inside one (gate architect shard 2 on
// #557 at 6632e62a). A first fix removed every long word-like run, and with it readable URLs such as
// /contact/candidate-phone-15125557319-details (Greptile on #562). Only the exact token shapes the file page mints are taken out
// now, each whole and bounded; everything else, a readable URL of any length included, is still read.
//   fs1.<64 hex>  session id      (file_session.ts newSessionId, SESSION_ID)
//   fp1.<64 hex>  page token      (file_session.ts pageTokenOf, PAGE_TOKEN)
//   v1.<b64url>.<43 b64url>  signed file link (file_link.ts mintFileToken)
export const TOKEN_SHAPES: readonly RegExp[] = [
  /(?<![0-9A-Za-z_.-])f[sp]1\.[0-9a-f]{64}(?![0-9A-Za-z_-])/g,
  /(?<![0-9A-Za-z_.-])v1\.[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{43}(?![0-9A-Za-z_-])/g,
];

export const tokensOut = (s: string) => TOKEN_SHAPES.reduce((t, re) => t.replace(re, " "), s);

export function phoneLeak(raw: string, phone: string, o: { last4?: boolean } = {}): boolean {
  const body = tokensOut(raw);
  const d = phone.replace(/[^0-9]/g, ""), d10 = d.slice(-10), last4 = d.slice(-4);
  return body.includes(phone) || body.includes(d10) || body.includes(d10.slice(3)) ||
    (!!o.last4 && new RegExp(`(?<![0-9A-Za-z])${last4}(?![0-9A-Za-z])`).test(body));
}
